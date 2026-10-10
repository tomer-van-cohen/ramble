/**
 * The server's own vital signs, for the admin page: how full the data volume is (in space
 * and in files — a volume runs out of inodes long before it runs out of bytes when it holds
 * many small files), how much memory the process uses, and what has gone wrong since it
 * started: writes the disk refused, sign-ups that were turned away. Counts only, in memory.
 */
import { statfsSync } from 'node:fs';
import { monitorEventLoopDelay, PerformanceObserver, constants } from 'node:perf_hooks';
import { dataDir } from './paths.js';
import { connectQueue } from './connectgate.js';

let startedAt = Date.now();
// Things that happen, counted since the start: a leak tends to follow one of them.
const counts = {};
export const bump = (name, by = 1) => { counts[name] = (counts[name] || 0) + (Number(by) || 0); };
// How long the process stood still, and what each full garbage collection cost and left behind: both come
// from Node's own counters, which measure without stopping anything.
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
// The same, over the last minute only: what the door to new sign-ups looks at. A new link is the
// one thing that can make the process stand still, so when it has just stood still, the next
// sign-up waits on the queue page until it has not, instead of a fixed number letting them in.
const recent = monitorEventLoopDelay({ resolution: 20 }); recent.enable();
const RECENT = []; // the last six 10-second maxima
setInterval(() => { RECENT.push(recent.max / 1e6); recent.reset(); if (RECENT.length > 6) RECENT.shift(); }, 10e3).unref?.();
export const STALL_PAUSE_MS = Number(process.env.STALL_PAUSE_MS ?? 2000) || 0; // 0 = never pause for stalls
/** The longest the event loop stood still in the last minute, in ms. */
export const recentStallMs = () => Math.max(0, ...RECENT, recent.max / 1e6);
/** Is the door open to a new sign-up, as far as load goes? { open, why } — why is 'stall' when it is not. */
export function admission() {
  const stall = recentStallMs();
  if (draining) return { open: false, why: 'deploy', stallMs: Math.round(stall) };
  // Right after a start every existing account is reconnecting: new links wait until that wave is through.
  const q = connectQueue();
  if (q.waiting > 0 || (Date.now() - startedAt < STARTUP_PAUSE_MS && q.inFlight > 0)) return { open: false, why: 'starting', stallMs: Math.round(stall) };
  if (STALL_PAUSE_MS > 0 && stall >= STALL_PAUSE_MS) return { open: false, why: 'stall', stallMs: Math.round(stall) };
  return { open: true, why: null, stallMs: Math.round(stall) };
}

// Before a deploy the door is closed (POST /admin/drain), so that no one is halfway through linking
// when the process restarts: a link the phone has not finished syncing is one WhatsApp drops.
let draining = false;
const STARTUP_PAUSE_MS = Number(process.env.STARTUP_PAUSE_MS ?? 60e3);
export const setDraining = (on) => { draining = !!on; return draining; };
export const isDraining = () => draining;
const gc = { majors: 0, longestMs: 0, totalMs: 0, heapAfterMajor: 0 };
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gc.totalMs += e.duration; if (e.duration > gc.longestMs) gc.longestMs = e.duration;
      if (e.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) { gc.majors++; gc.heapAfterMajor = process.memoryUsage().heapUsed; }
    }
  }).observe({ entryTypes: ['gc'] });
} catch { /* not on this Node */ }
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'EMFILE', 'ENFILE']);
const disk = { failures: 0, lastCode: null, lastAt: null };
const turnedAway = { full: 0, waiting: 0, rate: 0, stall: 0, deploy: 0, starting: 0, lastAt: null };

/** Any error, from anywhere: counted if it is the disk saying no. */
export function noteError(e) {
  const code = e?.code || (String(e?.message || e).match(/\b(ENOSPC|EDQUOT|EROFS|EIO|EMFILE|ENFILE)\b/) || [])[1];
  if (!DISK_CODES.has(code)) return false;
  disk.failures++; disk.lastCode = code; disk.lastAt = Date.now();
  return true;
}
/** A sign-up that did not get an account: 'full' (capacity), 'waiting' (too many unscanned), 'rate' (per-address limit). */
export function noteTurnedAway(why) { if (why in turnedAway) { turnedAway[why]++; turnedAway.lastAt = Date.now(); } }

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : null);
/** Space and file slots on the data volume; null where the platform cannot say. Pure given a statfs result; exported for tests. */
export function diskUsage(stat = (() => { try { return statfsSync(dataDir); } catch { return null; } })()) {
  if (!stat) return null;
  const n = (v) => Number(v);
  return {
    spacePct: pct(n(stat.blocks) - n(stat.bfree), n(stat.blocks)), freeMb: Math.round((n(stat.bavail) * n(stat.bsize)) / 1e6),
    filesPct: pct(n(stat.files) - n(stat.ffree), n(stat.files)), filesUsed: n(stat.files) - n(stat.ffree), filesFree: n(stat.ffree),
  };
}

export function snapshot() {
  const mem = process.memoryUsage();
  return {
    startedAt, uptimeMinutes: Math.round((Date.now() - startedAt) / 60e3),
    memoryMb: Math.round(mem.rss / 1e6),
    // Which kind of memory it is: objects on the JS heap, or bytes held outside it (buffers: media, protocol frames).
    memory: { heapUsedMb: Math.round(mem.heapUsed / 1e6), heapTotalMb: Math.round(mem.heapTotal / 1e6), buffersMb: Math.round((mem.external + mem.arrayBuffers) / 1e6) },
    disk: diskUsage(), diskFailures: { ...disk }, turnedAway: { ...turnedAway }, admission: admission(),
  };
}
/**
 * One line for the log, every few minutes: what kind of memory is in use and how many timers and
 * sockets the process holds. A leak shows in which of these keeps climbing while accounts do not.
 */
export function memoryLine(accounts = null) {
  const mem = process.memoryUsage(), gb = (n) => (n / 1e9).toFixed(2);
  const held = {};
  try { for (const kind of process.getActiveResourcesInfo()) held[kind] = (held[kind] || 0) + 1; } catch { /* older Node */ }
  const top = Object.entries(held).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
  // Since the previous line: the longest the event loop was stuck, and the garbage collector's share of it.
  const stalled = loop.max / 1e6; loop.reset();
  const pauses = ` · longest stall ${(stalled / 1000).toFixed(1)}s · gc: ${gc.majors} full, longest ${Math.round(gc.longestMs)}ms, ${(gc.totalMs / 1000).toFixed(1)}s in all${gc.heapAfterMajor ? `, ${gb(gc.heapAfterMajor)} GB live after the last full one` : ''}`;
  Object.assign(gc, { majors: 0, longestMs: 0, totalMs: 0 });
  const since = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ');
  return `🧠 memory ${gb(mem.rss)} GB (heap ${gb(mem.heapUsed)} of ${gb(mem.heapTotal)}, buffers ${gb(mem.external + mem.arrayBuffers)})${accounts ? ` · ${accounts.total} accounts, ${accounts.connected} connected` : ''} · up ${Math.round((Date.now() - startedAt) / 60e3)}m · holding: ${top || 'n/a'}${pauses}${since ? ` · since start: ${since}` : ''}`;
}
export const _reset = () => { Object.assign(disk, { failures: 0, lastCode: null, lastAt: null }); Object.assign(turnedAway, { full: 0, waiting: 0, rate: 0, stall: 0, deploy: 0, starting: 0, lastAt: null }); RECENT.length = 0; recent.reset(); draining = false; startedAt = 0; }; // tests
export const _stalled = (ms) => { RECENT.push(ms); }; // tests: pretend the loop just stood still
