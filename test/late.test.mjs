// node --test test/late.test.mjs — a recording that reaches the server long after it was sent (the server was
// down, a backlog) is left alone: its text would pop up out of context. Invented chats throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-late-'));
process.env.CLAIM_YIELD_MS = '5';
process.env.MAX_RECORDING_AGE_MS = '60000';
const { Tenant, MAX_RECORDING_AGE_MS } = await import('../src/tenant.js');

const CONTROL = '999@g.us', FRIEND = '444@s.whatsapp.net';
let seq = 0;
function tenant() {
  const id = `l${++seq}`;
  const t = new Tenant({ id, createdAt: Date.now() }, join(process.env.DATA_DIR, id));
  t.target = { jid: CONTROL, name: 'Ramble' };
  t.worked = []; t.lines = [];
  t.sendPaced = async () => ({ key: { id: `S${++seq}` } });
  t.handleRecording = async (m, n) => { t.worked.push(`${n.fromMe ? 'mine' : 'theirs'}@${n.chatId}`); return true; };
  t.sock = {};
  return t;
}
const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30, ptt: true };
const rec = (t, chatId, fromMe, agoMs) => { const id = `V${++seq}`; return t.onMessage({ key: { remoteJid: chatId, fromMe, id }, pushName: 'Someone', messageTimestamp: Math.floor((Date.now() - agoMs) / 1000), message: { audioMessage: { ...node, fileSha256: Buffer.from(id) } } }, t.sock); };

test('fresh recordings are transcribed; one sent minutes ago is left alone, the owner\'s own too', async () => {
  const t = tenant();
  await rec(t, FRIEND, false, 2000); await rec(t, FRIEND, true, 30_000);
  assert.deepEqual(t.worked, [`theirs@${FRIEND}`, `mine@${FRIEND}`]);
  const log = console.log; const lines = []; console.log = (l) => lines.push(String(l));
  try { await rec(t, FRIEND, false, 23 * 60_000); await rec(t, FRIEND, true, MAX_RECORDING_AGE_MS + 5000); } finally { console.log = log; }
  assert.deepEqual(t.worked, [`theirs@${FRIEND}`, `mine@${FRIEND}`], 'nothing more');
  assert.equal(lines.filter((l) => /too late for its text/.test(l)).length, 2);
  assert.ok(lines.every((l) => !/444|Someone/.test(l)), 'the line says how old, not whose');
});

test('a forward into the control group is asked for: its age does not matter', async () => {
  const t = tenant();
  await rec(t, CONTROL, true, 23 * 60_000);
  assert.deepEqual(t.worked, [`mine@${CONTROL}`]);
});

test('a message without a time is taken as fresh', async () => {
  const t = tenant(); const id = `V${++seq}`;
  await t.onMessage({ key: { remoteJid: FRIEND, fromMe: false, id }, message: { audioMessage: { ...node, fileSha256: Buffer.from(id) } } }, t.sock);
  assert.deepEqual(t.worked, [`theirs@${FRIEND}`]);
});
