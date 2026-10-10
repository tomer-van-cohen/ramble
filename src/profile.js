/**
 * Where the processor's time and the live memory come from, measured by V8's own sampling
 * profilers and written to the log as two short lines of function names. Sampling does not
 * walk the heap or stop the process: the processor is sampled for half a minute at a time,
 * allocations one in every few megabytes, and only what is still alive is reported.
 * No data is read, only which code allocated or ran.
 *
 *   PROFILE=0   turns it off
 */
import { Session } from 'node:inspector/promises';

const ON = process.env.PROFILE !== '0';
const CPU_SECONDS = 30;
const HEAP_INTERVAL = 16 * 1024 * 1024; // one sample per ~16 MB allocated
let session = null;

const where = (cf) => {
  const url = String(cf.url || '');
  const file = url.includes('node_modules/') ? url.replace(/^.*node_modules\//, '').split('/').slice(-4).join('/') : url.replace(/^.*\/src\//, 'src/').split('/').slice(-3).join('/');
  return `${cf.functionName || '(anonymous)'} ${file || '(native)'}:${cf.lineNumber + 1}`;
};

/** Top functions by their own processor time in a CPU profile. Pure; exported for tests. */
export function topCpu(profile, n = 10) {
  const total = profile.endTime - profile.startTime || 1;
  const self = new Map();
  const dt = profile.timeDeltas || [], byId = new Map(profile.nodes.map((node) => [node.id, node]));
  (profile.samples || []).forEach((id, i) => { const node = byId.get(id); if (!node) return; const k = where(node.callFrame); self.set(k, (self.get(k) || 0) + (dt[i] || 0)); });
  return [...self].filter(([k]) => !/^\(idle\)|^\(program\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, t]) => `${k} ${((t / total) * 100).toFixed(1)}%`);
}

/** Top allocation sites by bytes still alive, with the nearest caller that is not a library internal. Pure; exported for tests. */
export function topLive(head, n = 10) {
  const sites = new Map(); let total = 0;
  const walk = (node, path) => {
    const here = [...path, node.callFrame];
    if (node.selfSize) {
      total += node.selfSize;
      const own = where(node.callFrame);
      const caller = [...path].reverse().find((cf) => cf.url && where(cf) !== own);
      const k = caller ? `${own} ← ${where(caller)}` : own;
      sites.set(k, (sites.get(k) || 0) + node.selfSize);
    }
    for (const child of node.children || []) walk(child, here);
  };
  walk(head, []);
  return { totalMb: Math.round(total / 1e6), top: [...sites].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, b]) => `${k} ${Math.round(b / 1e6)}MB`) };
}

let cpuBusy = false; // one CPU profile at a time, whoever asked
/** A one-off CPU profile around something specific (a new link), logged under `label`; one at a time. */
export function profileOnce(label, seconds = 45) {
  if (!session || cpuBusy) return false;
  cpuBusy = true;
  (async () => {
    try {
      await session.post('Profiler.start');
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const { profile } = await session.post('Profiler.stop');
      console.log(`🔎 ${label}, ${seconds}s: ${topCpu(profile, 12).join(' · ')}`.slice(0, 1800));
    } catch (e) { console.warn(`🔎 ${label} profile failed: ${e.message}`); }
    cpuBusy = false;
  })();
  return true;
}

export async function startProfiling() {
  if (!ON || session) return false;
  try {
    session = new Session(); session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: HEAP_INTERVAL });
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 5000 }); // every 5 ms
    return true;
  } catch (e) { console.warn(`🔎 profiling unavailable: ${e.message}`); session = null; return false; }
}

/** The two lines, as text. Takes CPU_SECONDS to return. */
export async function profileLines(cpuSeconds = CPU_SECONDS) {
  if (!session) return [];
  const lines = [];
  if (!cpuBusy) try {
    cpuBusy = true;
    await session.post('Profiler.start');
    await new Promise((r) => setTimeout(r, cpuSeconds * 1000));
    const { profile } = await session.post('Profiler.stop');
    lines.push(`🔎 cpu, ${cpuSeconds}s: ${topCpu(profile).join(' · ')}`);
  } catch (e) { lines.push(`🔎 cpu profile failed: ${e.message}`); } finally { cpuBusy = false; }
  try {
    const { profile } = await session.post('HeapProfiler.getSamplingProfile');
    const live = topLive(profile.head);
    lines.push(`🔎 live allocations (sampled, ~${live.totalMb} MB seen): ${live.top.join(' · ')}`);
  } catch (e) { lines.push(`🔎 heap profile failed: ${e.message}`); }
  return lines;
}
