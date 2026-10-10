// node --test test/claims.test.mjs — one recording gets one text when both sides of a chat have an account here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-claims-'));
process.env.CLAIM_YIELD_MS = '300'; // wide apart from "no wait", so a loaded CI runner cannot blur the two
process.env.CLAIM_WAIT_MS = '400';
const { Tenant } = await import('../src/tenant.js');
const claims = await import('../src/claims.js');

const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30, ptt: true, fileSha256: Buffer.from('same-recording') };
let seq = 0;
// An account whose transcription is a stub: `result` is what happens to the recordings it works on.
function account(id, result = async () => true) {
  const t = new Tenant({ id, createdAt: Date.now() }, join(process.env.DATA_DIR, `${id}-${++seq}`));
  t.worked = [];
  t.handleRecording = async (m, n) => { t.worked.push(n.id); return result(); };
  t.sock = {};
  claims.link(id, [`${id}@s.whatsapp.net`]); // connected, as onReady does
  return t;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The same WhatsApp message, as each side sees it: same id and recording, its own chat and direction.
const note = (id, fromMe, remoteJid) => ({ key: { remoteJid, fromMe, id }, pushName: fromMe ? undefined : 'Alex', message: { audioMessage: node } });

test('both sides have an account: the sender\'s posts, the recipient\'s adds nothing — whichever saw the message first', async () => {
  for (const recipientFirst of [false, true]) {
    const alex = account('alex'), ben = account('ben'); const id = `M${++seq}`;
    const runs = recipientFirst
      ? [ben.onMessage(note(id, false, 'alex@s.whatsapp.net'), ben.sock), sleep(10).then(() => alex.onMessage(note(id, true, 'ben@s.whatsapp.net'), alex.sock))]
      : [alex.onMessage(note(id, true, 'ben@s.whatsapp.net'), alex.sock), ben.onMessage(note(id, false, 'alex@s.whatsapp.net'), ben.sock)];
    await Promise.all(runs);
    assert.deepEqual(alex.worked, [id], 'the sender transcribed it'); assert.deepEqual(ben.worked, [], `the recipient did not (recipient first: ${recipientFirst})`);
  }
});

test('the sender cannot (over its limit, a failure): the recipient steps in, so there is always one text', async () => {
  for (const result of [async () => false, async () => undefined, async () => { throw new Error('provider down'); }]) {
    const alex = account('alex', result), ben = account('ben'); const id = `M${++seq}`;
    await Promise.all([alex.onMessage(note(id, true, 'ben@s.whatsapp.net'), alex.sock).catch(() => {}), ben.onMessage(note(id, false, 'alex@s.whatsapp.net'), ben.sock)]);
    assert.deepEqual(ben.worked, [id]);
  }
});

test('a sender without an account here: the recipient transcribes right away, with no head start to wait out', async () => {
  const ben = account('ben'); const id = `M${++seq}`;
  const t0 = Date.now();
  await ben.onMessage(note(id, false, 'stranger@s.whatsapp.net'), ben.sock);
  assert.deepEqual(ben.worked, [id]);
  assert.ok(Date.now() - t0 < 150, `waited ${Date.now() - t0} ms`);
});

test('a sender with an account here gets the head start; a disconnected one does not', async () => {
  const ben = account('ben'); account('alex');
  let id = `M${++seq}`, t0 = Date.now();
  await ben.onMessage(note(id, false, 'alex@s.whatsapp.net'), ben.sock);
  assert.ok(Date.now() - t0 >= 250, 'waited for alex');
  claims.unlink('alex');
  id = `M${++seq}`; t0 = Date.now();
  await ben.onMessage(note(id, false, 'alex@s.whatsapp.net'), ben.sock);
  assert.ok(Date.now() - t0 < 150, 'alex is gone: no wait');
});

test('a group with several accounts and an outside sender: exactly one of them posts', async () => {
  const members = ['ben', 'carmel', 'dana'].map((n) => account(n)); const id = `M${++seq}`;
  for (const t of members) t.enabled.add('family@g.us');
  await Promise.all(members.map((t) => t.onMessage({ ...note(id, false, 'family@g.us'), key: { remoteJid: 'family@g.us', fromMe: false, id, participant: 'stranger@s.whatsapp.net' } }, t.sock)));
  assert.equal(members.reduce((sum, t) => sum + t.worked.length, 0), 1);
});

test('an owner that never reports back does not hold a recording forever', async () => {
  const id = `M${++seq}`;
  const ben = account('ben');
  const n = ben.normalize(note(id, false, 'alex@s.whatsapp.net'));
  assert.equal(claims.take(`${n.id}|${n.mediaSha || ''}`, 'ghost'), true);
  await ben.onMessage(note(id, false, 'alex@s.whatsapp.net'), ben.sock);
  assert.deepEqual(ben.worked, [id], 'taken over after the wait');
});

test('the control group is never shared: its recordings skip the claim', async () => {
  const ben = account('ben'); ben.target = { jid: 'control@g.us', name: 'Ramble' }; const id = `M${++seq}`;
  claims.take(`${id}|${ben.normalize(note(id, true, 'control@g.us')).mediaSha || ''}`, 'someone-else');
  await ben.onMessage(note(id, true, 'control@g.us'), ben.sock);
  assert.deepEqual(ben.worked, [id]);
});
