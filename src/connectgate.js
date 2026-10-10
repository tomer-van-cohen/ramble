/**
 * Connections to WhatsApp are opened a few at a time.
 *
 * Every account here connects from the same address. When a restart, or a stall that
 * drops every socket at once, sends hundreds of them back together, most of the
 * attempts time out, retry together and time out again: the reconnects become the
 * outage. So an attempt takes a slot first and gives it back as soon as its socket has
 * an answer (open, closed, or a QR to show), or after a few seconds at the latest.
 *
 *   CONNECT_CONCURRENCY   attempts in flight at once (default 10)
 */
import { createSemaphore } from './semaphore.js';

const CONCURRENCY = Math.max(1, Number(process.env.CONNECT_CONCURRENCY ?? 10) || 10);
const MAX_HOLD_MS = 12_000;
const gate = createSemaphore(CONCURRENCY);

/** Resolves, in arrival order, to a function that gives the slot back (safe to call more than once). */
export function connectSlot(maxHoldMs = MAX_HOLD_MS) {
  return new Promise((taken) => {
    gate.run(() => new Promise((free) => {
      let done = false;
      const release = () => { if (done) return; done = true; clearTimeout(timer); free(); };
      const timer = setTimeout(release, maxHoldMs); timer.unref?.();
      taken(release);
    }));
  });
}
export const connectQueue = () => ({ inFlight: gate.active, waiting: gate.waiting });

/** A reconnect delay spread around its nominal value, so sockets that dropped together do not come back together. */
export const jitter = (ms, random = Math.random) => Math.round(ms * (0.6 + random() * 0.8));
