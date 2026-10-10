// node --test test/experiment.test.mjs — the correction delta, the records and the summary (the draw is the brain's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-experiment-'));
const { wordDelta, summarize, record, readRecords } = await import('../src/experiments.js');
test('the delta is the share of raw words the correction did not keep, punctuation ignored', () => {
  assert.equal(wordDelta('אני מגיע בעוד עשר דקות', 'אני מגיע בעוד עשר דקות.'), 0);
  assert.equal(wordDelta('אני מגיע בעוד עשר דקות', 'אני מגיעה בעוד עשר דקות'), 0.2);
  assert.equal(wordDelta('', 'משהו'), 0);
  assert.equal(wordDelta('א ב ג ד', 'ד ג ב א'), 0.75, 'reordering counts as change');
});

test('records are appended by day and summarised per arm and segment, signals per 1,000 posts', () => {
  const at = Date.now();
  record({ kind: 'recording', at, arm: 'A', sec: 10, posted: true, delta: 0.05, stt: 1, total: 5, usd: 0.001, gate: 'ok' });
  record({ kind: 'recording', at, arm: 'B', sec: 70, posted: true, delta: 0.2, stt: 0.5, total: 4, usd: 0.0002, gate: 'ok', video: true });
  record({ kind: 'recording', at, arm: 'B', sec: 8, posted: false, gate: 'wrong script', fallback: null });
  record({ kind: 'rerecord', at, arm: 'B', gap: 12.4 });
  record({ kind: 'rerecord', at, arm: 'B', gap: 41.9 });
  record({ kind: 'revoke', at, arm: 'A', gap: 40 });
  const rows = summarize(readRecords({ days: 1 }));
  const b = rows.find((r) => r.arm === 'B' && r.segment === 'all'), a = rows.find((r) => r.arm === 'A' && r.segment === 'all');
  assert.equal(b.n, 2); assert.equal(b.gateDrop, 500); assert.equal(b.deltaMedian, 0.2);
  assert.equal(b.rerecorded, 2000); assert.equal(b.rerecordGapMedian, 41.9); assert.deepEqual(b.rerecordGaps, [12.4, 41.9]);
  assert.equal(a.revokes, 1000); assert.equal(a.usdPerMin, 0.006);
  assert.ok(rows.some((r) => r.arm === 'B' && r.segment === 'len:60–120s'));
  assert.ok(rows.some((r) => r.arm === 'B' && r.segment === 'video'));
  assert.ok(!JSON.stringify(rows).includes('text'), 'no texts in the summary');
});
