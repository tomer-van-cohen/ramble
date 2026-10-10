/**
 * Tiny counting semaphore: at most `max` jobs run at once, the rest wait in
 * order. Used to bound transcription work per account and across the process,
 * so one busy account can't starve the others or the box.
 */
export function createSemaphore(max) {
  let active = 0;
  const waiting = [];
  const release = () => { active--; const next = waiting.shift(); if (next) { active++; next(); } };
  return {
    get active() { return active; },
    get waiting() { return waiting.length; },
    async run(fn) {
      if (active < max) active++;
      else await new Promise((resolve) => waiting.push(resolve));
      try { return await fn(); } finally { release(); }
    },
  };
}
