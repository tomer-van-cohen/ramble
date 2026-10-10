// node --test test/watchdog.test.mjs — a process whose main thread is stuck is killed, so the platform restarts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const watchdog = fileURLToPath(new URL('../src/watchdog.js', import.meta.url));
const run = (body) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { startWatchdog } from ${JSON.stringify(watchdog)};\n${body}`], { encoding: 'utf8', timeout: 20_000 });

test('a main thread stuck past the limit: one line on stderr, and the process is killed', () => {
  const r = run(`startWatchdog({ stallMs: 600, beatMs: 50 }); const until = Date.now() + 10_000; while (Date.now() < until) {} console.log('survived');`);
  assert.equal(r.signal, 'SIGKILL');
  assert.match(r.stderr, /watchdog: the main thread has been stuck for \ds/);
  assert.doesNotMatch(r.stdout, /survived/);
});

test('a busy but breathing thread is left alone, and the watchdog never keeps the process alive', () => {
  const r = run(`startWatchdog({ stallMs: 600, beatMs: 50 }); let n = 0; const t = setInterval(() => { const until = Date.now() + 200; while (Date.now() < until) {} if (++n === 10) { clearInterval(t); console.log('done'); } }, 10);`);
  assert.equal(r.signal, null); assert.equal(r.status, 0); assert.match(r.stdout, /done/);
});

test('switched off with WATCHDOG_STALL_MS=0', async () => {
  const { startWatchdog } = await import('../src/watchdog.js');
  assert.equal(startWatchdog({ stallMs: 0 }), null);
});
