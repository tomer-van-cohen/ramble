// node --test test/pacing.test.mjs — a lone message goes at once; one right after another from the
// same account waits 1–3 s, so a burst never reads as a bot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-pacing-'));
const { Tenant } = await import('../src/tenant.js');

function account(id) {
  const t = new Tenant({ id, createdAt: Date.now() }, join(process.env.DATA_DIR, id));
  t.sent = [];
  t.sock = { sendMessage: async (jid) => { t.sent.push({ jid, at: Date.now() }); return { key: { id: `S${t.sent.length}` } }; } };
  return t;
}

test('a lone message is sent at once', async () => {
  const t = account('a'); const t0 = Date.now();
  await t.sendPaced('x@s.whatsapp.net', { text: 'hi' });
  assert.ok(Date.now() - t0 < 100, `${Date.now() - t0} ms`);
});

test('a second message right after the first waits 1–3 s; accounts do not pace each other', async () => {
  const a = account('b'), b = account('c'); const t0 = Date.now();
  await Promise.all([a.sendPaced('x@s.whatsapp.net', { text: '1' }), a.sendPaced('x@s.whatsapp.net', { text: '2' }), b.sendPaced('y@s.whatsapp.net', { text: '3' })]);
  const gap = a.sent[1].at - a.sent[0].at;
  assert.ok(gap >= 1000 && gap < 3200, `gap ${gap} ms`);
  assert.ok(b.sent[0].at - t0 < 100, 'the other account was not held up');
});
