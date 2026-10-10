/**
 * A process whose one thread is stuck serves no one, but nothing outside notices: it has not
 * crashed, so it is not restarted, and every account waits. When incoming messages pile up
 * faster than they can be decrypted, memory grows until the thread does nothing but collect
 * garbage, and that can last until someone restarts it by hand.
 *
 * The main thread writes the time into shared memory every second. A separate thread, which
 * keeps running while the main one is stuck, checks it; when the main thread has been silent
 * for WATCHDOG_STALL_MS, it writes one line straight to stderr (console would wait for the
 * stuck thread) and kills the process, and the platform starts a fresh one.
 */
import { Worker } from 'node:worker_threads';

export const WATCHDOG_STALL_MS = Number(process.env.WATCHDOG_STALL_MS ?? 90_000);

const WATCHER = `
const { workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const { beat, stallMs, checkMs } = workerData;
setInterval(() => {
  const silent = Date.now() - Number(Atomics.load(beat, 0));
  if (silent < stallMs) return;
  try { writeSync(2, '🐕 watchdog: the main thread has been stuck for ' + Math.round(silent / 1000) + 's — killing the process so it restarts\\n'); } catch {}
  process.kill(process.pid, 'SIGKILL');
}, checkMs);
`;

/** Start the heartbeat and its watcher. Returns a stop function (tests), or null when switched off. */
export function startWatchdog({ stallMs = WATCHDOG_STALL_MS, beatMs = 1000 } = {}) {
  if (!(stallMs > 0)) return null;
  const beat = new BigInt64Array(new SharedArrayBuffer(8));
  const tick = () => Atomics.store(beat, 0, BigInt(Date.now()));
  tick();
  const timer = setInterval(tick, beatMs);
  timer.unref?.();
  const worker = new Worker(WATCHER, { eval: true, execArgv: [], workerData: { beat, stallMs, checkMs: Math.min(5000, Math.max(100, stallMs / 6)) } });
  worker.unref();
  return () => { clearInterval(timer); worker.terminate(); };
}
