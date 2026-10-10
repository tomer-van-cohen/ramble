// node --test test/timing.test.mjs — one timing line per recording: each step in seconds, nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-timing-'));
const { Tenant } = await import('../src/tenant.js');

test('the timing line has every step, the sender delay, the retry if any — and no content', () => {
  const t = new Tenant({ id: 'tm', createdAt: Date.now() }, join(process.env.DATA_DIR, 'tm'));
  const at = 1_800_000_000_000;
  const n = { seconds: 6, fromMe: false, body: 'secret words', t: { sentAt: at - 2000, arrived: at, claimed: at + 1500, slot: at + 1500, downloaded: at + 1800, measured: at + 1900, transcribed: at + 3100, corrected: at + 4600, posted: at + 7000 } };
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { t.logTiming(n, false, 'hint'); } finally { console.log = orig; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /⏱️ 6s voice: wa 2 · claim 1\.5 · queue 0\.0 · download 0\.3 · measure 0\.1 · stt 1\.2 \(hint retry\) · fix 1\.5 · send 2\.4 · total 7\.0s$/);
  assert.ok(!lines[0].includes('secret'));
});

test('a step that did not happen shows as –, and the owner\'s own note is marked', () => {
  const t = new Tenant({ id: 'tm2', createdAt: Date.now() }, join(process.env.DATA_DIR, 'tm2'));
  const at = 1_800_000_000_000;
  const n = { seconds: 3, fromMe: true, t: { arrived: at, slot: at, downloaded: at + 200, measured: at + 250, transcribed: at + 900, corrected: at + 1900, posted: at + 4000 } };
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { t.logTiming(n, false, null); } finally { console.log = orig; }
  assert.match(lines[0], /3s voice \(own\): wa – · claim – · queue 0\.0 · .* · total 4\.0s$/);
});
