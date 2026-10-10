/**
 * Entry point: load every linked account, start them, serve the site.
 */
import './logguard.js'; // first: nothing may print session keys, from the first line on
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, dataDirIsMount } from './paths.js';
import { noteError, memoryLine } from './health.js';
import { connectQueue } from './connectgate.js';
import { startProfiling, profileLines } from './profile.js';
import * as registry from './registry.js';
import { createWebApp } from './web.js';
import { PRODUCT_NAME, DEFAULT_PLAN, DAILY_MINUTES_CAP, MAX_TRANSCRIBE_SECONDS } from './tenant.js';
import { brain, brainSource } from './brain/index.js';
import { GLOBAL_DAILY_MINUTES, secondsToday } from './budget.js';
import * as research from './research.js';
import { configureConnections } from './net.js';
import { startWatchdog, WATCHDOG_STALL_MS } from './watchdog.js';

// Before the first connection: give each connection attempt time on a busy server (net.js).
configureConnections();
// Everything this process writes (session keys, settings, media) is private to it.
process.umask(0o077);
// ffmpeg scratch files from a previous crash: remove anything older than an hour.
try { for (const f of readdirSync(tmpdir())) if (/^wa_\d+_[a-z0-9]+\.mp3$/.test(f)) { const p = join(tmpdir(), f); if (Date.now() - statSync(p).mtimeMs > 3600e3) unlinkSync(p); } } catch { /* best effort */ }

const PORT = Number(process.env.PORT ?? 4599);
const HOST = process.env.HOST || '127.0.0.1';

process.on('unhandledRejection', (e) => { noteError(e); console.warn('⚠️  unhandledRejection:', e?.message || e); });
process.on('uncaughtException', (e) => { noteError(e); console.warn('⚠️  uncaughtException:', e?.message || e); });

console.log(`Starting ${PRODUCT_NAME}… (uid ${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}${typeof process.getuid === 'function' && process.getuid() === 0 ? ' — ROOT; the container entrypoint should have dropped privileges' : ''})`);
const info = brain.info();
if (!info.enabled) console.error('❌ No transcription provider configured — nothing will be transcribed.');
console.log(`🧠 Brain: ${brainSource}${brainSource === 'plain' ? ' (one transcription, delivered as it came)' : ''} · new accounts start on "${DEFAULT_PLAN}"`);
for (const line of info.startupLines()) console.log(line);
console.log(`💰 Caps: ${DAILY_MINUTES_CAP || '∞'} min/day per account · ${GLOBAL_DAILY_MINUTES || '∞'} min/day for this server (${Math.round(secondsToday() / 60)} used today) · ${MAX_TRANSCRIBE_SECONDS ? `${Math.round(MAX_TRANSCRIBE_SECONDS / 60)} min` : 'no limit'} per recording · the same recording twice is free`);
const mounted = dataDirIsMount();
if (mounted === false) console.error(`🚨 DATA_DIR ${dataDir} is NOT a mounted volume — every linked account will be LOST on the next restart.`);
else if (mounted === true) console.log(`💾 DATA_DIR ${dataDir}: mounted volume ✓`);

// Recordings kept by accounts that opted in: sweep by age and size, now and hourly.
research.sweep();
setInterval(() => research.sweep(), 3600e3).unref?.();
const kept = research.usage();
if (kept.files) console.log(`🎧 Kept recordings (opt-in): ${kept.files} file(s), ${Math.round(kept.bytes / 1e6)} MB across ${kept.accounts} account(s); pruned after ${research.RESEARCH_KEEP_DAYS} days or ${research.RESEARCH_MAX_MB} MB`);

registry.migrateLegacy();
const tenants = registry.loadAll();
console.log(`👥 ${tenants.length} linked account(s) (capacity ${registry.MAX_TENANTS})`);
registry.startAll();
// Which code is using the processor and holding the memory: two lines every ten minutes (see profile.js).
startProfiling().then((on) => { if (on) setInterval(() => { profileLines().then((lines) => lines.forEach((l) => console.log(l.slice(0, 1800)))).catch(() => {}); }, 10 * 60e3).unref?.(); });
// What the process holds, into the log every ten minutes, so a climb can be read after the fact.
setInterval(() => { const ts = registry.list(); const q = connectQueue(); console.log(`${memoryLine({ total: ts.length, connected: ts.filter((t) => t.ready).length })} · connecting ${q.inFlight}, queued ${q.waiting}`); }, 10 * 60e3).unref?.();

createWebApp().listen(PORT, HOST, () => {
  console.log(`🌐 Site: http://${HOST === '0.0.0.0' ? '<your-host>' : 'localhost'}:${PORT}  (admin at /admin${process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD ? '' : ' — disabled, set ADMIN_PASSWORD'})`);
  // From here on, a main thread stuck for this long means a restart, not an outage until someone notices (watchdog.js).
  if (startWatchdog()) console.log(`🐕 Watchdog: restarts the process if it is stuck for ${Math.round(WATCHDOG_STALL_MS / 1000)}s`);
});
