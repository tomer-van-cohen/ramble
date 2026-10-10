// node --test test/pause.test.mjs — pause and resume, from the control group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-pause-'));
process.env.CLAIM_YIELD_MS = '5';
const { Tenant } = await import('../src/tenant.js');

const CONTROL = 'control@g.us';
const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30, ptt: true, fileSha256: Buffer.from('a-recording') };
let seq = 0;
function tenant(rec = {}) {
  const t = new Tenant({ id: `p${++seq}`, createdAt: Date.now(), ...rec }, join(process.env.DATA_DIR, `p${seq}`));
  t.target = { jid: CONTROL, name: 'Ramble' };
  t.out = []; t.worked = [];
  t.sendPaced = async (jid, content) => { t.out.push({ jid, ...content }); return { key: { id: `S${++seq}` } }; };
  t.handleRecording = async (m, n) => { t.worked.push(n.id); return true; };
  t.sock = {};
  return t;
}
const say = (t, body) => { const key = { remoteJid: CONTROL, fromMe: true, id: `T${++seq}` }; const message = { conversation: body }; return t.handleCommand({ key, message }, t.normalize({ key, message }), 'Ramble'); };
const voice = (t, chat, fromMe = false) => t.onMessage({ key: { remoteJid: chat, fromMe, id: `V${++seq}` }, pushName: 'Someone', message: { audioMessage: node } }, t.sock);

test('pause stops every transcription; resume brings it back; the state survives a restart', async () => {
  const t = tenant();
  assert.equal(await say(t, 'Pause'), true);
  assert.equal(t.paused, true); assert.match(t.out.at(-1).text, /Paused/);
  await voice(t, 'friend@s.whatsapp.net'); await voice(t, 'friend@s.whatsapp.net', true);
  assert.deepEqual(t.worked, [], 'nothing transcribed while paused');
  assert.equal(new Tenant({ id: t.id, createdAt: t.createdAt, paused: true }, t.dir).paused, true);
  assert.equal(await say(t, 'pause'), true); assert.match(t.out.at(-1).text, /Already paused/);
  assert.equal(await say(t, 'resume'), true);
  assert.equal(t.paused, false); assert.match(t.out.at(-1).text, /Back on/);
  await voice(t, 'friend@s.whatsapp.net');
  assert.equal(t.worked.length, 1);
  assert.equal(await say(t, 'resume'), true); assert.match(t.out.at(-1).text, /running/);
});

test('a recording in the group while paused gets a reminder, not a transcript', async () => {
  const t = tenant({ paused: true });
  await voice(t, CONTROL, true);
  assert.deepEqual(t.worked, []); assert.match(t.out.at(-1).text, /resume/);
});

test('in Hebrew, every line starts with a Hebrew letter; help lists pause and resume', async () => {
  const t = tenant({ locale: 'he' });
  const texts = ['paused', 'resumed', 'already-paused', 'already-running', 'paused-note'].map((h) => t.pauseReply(h));
  for (const x of texts) assert.match(x.match(/\p{L}/u)[0], /[֐-׿]/, x);
  assert.match(t.helpText(), /\*pause\* \/ \*resume\*/);
  assert.equal(await say(t, 'עצור'), false, 'commands are one English word');
});
