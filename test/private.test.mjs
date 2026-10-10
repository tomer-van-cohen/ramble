// node --test test/private.test.mjs — private mode: other people's recordings in a chat are transcribed
// into the control group only; nothing is posted in the chat. Invented contacts and groups throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-private-'));
process.env.CLAIM_YIELD_MS = '20';
process.env.CLAIM_WAIT_MS = '300';
const { Tenant } = await import('../src/tenant.js');

const CONTROL = '999@g.us';
const RON = '444@s.whatsapp.net', CLUB = '555@g.us';
let seq = 0;
function tenant(id = `pv${++seq}`) {
  const dir = join(process.env.DATA_DIR, id);
  const t = new Tenant({ id, createdAt: Date.now() }, dir);
  t.target = { jid: CONTROL, name: 'Ramble' };
  t.contactNames = new Map([[RON, 'Ron Levi']]);
  t.out = [];
  t.sendPaced = async (jid, content, opts = {}) => { t.out.push({ jid, ...content, quoted: !!opts.quoted }); return { key: { id: `S${++seq}` } }; };
  t.sock = { sendMessage: async () => ({ key: { id: `S${++seq}` } }), groupFetchAllParticipating: async () => ({ [CLUB]: { subject: 'Book club' }, [CONTROL]: { subject: 'Ramble' } }) };
  // Transcription stands in: every recording becomes the same short text, delivered the usual way.
  t.transcribed = [];
  t.handleRecording = async (m, n, chatName, isVideo) => { t.transcribed.push(n.id); return t.deliver(n, chatName, '*Running late*\nI will be there at eight.', isVideo, m); };
  return t;
}
const say = (t, body, quotedId = null) => {
  const key = { remoteJid: CONTROL, fromMe: true, id: `T${++seq}` };
  const message = quotedId ? { extendedTextMessage: { text: body, contextInfo: { stanzaId: quotedId } } } : { conversation: body };
  return t.handleCommand({ key, message }, t.normalize({ key, message }), 'Ramble');
};
const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30, ptt: true };
const recording = (chatId, { fromMe = false, participant, expiration, id = `V${++seq}` } = {}) => ({
  key: { remoteJid: chatId, fromMe, id, ...(participant ? { participant } : {}) }, pushName: fromMe ? undefined : 'Ron',
  message: { audioMessage: { ...node, fileSha256: Buffer.from(id), ...(expiration ? { contextInfo: { expiration } } : {}) } },
});
const exclusive = (t, ids) => { for (const id of ids) assert.ok([t.muted.has(id), t.quiet.has(id), t.enabled.has(id)].filter(Boolean).length <= 1, `one mode for ${id}`); };

test('private <name> asks first, then moves the chat to private mode', async () => {
  const t = tenant();
  assert.equal(await say(t, 'private Ron'), true);
  assert.match(t.out[0].text, /Transcribe \*Ron Levi \(…444\)\* privately\?/); assert.match(t.out[0].text, /yours included/);
  assert.equal(t.quiet.size, 0, 'asking changes nothing');
  assert.equal(await say(t, 'yes'), true);
  assert.ok(t.quiet.has(RON)); assert.equal(t.chatMode(RON), 'private');
  assert.match(t.out.at(-1).text, /Done: \*Ron Levi\* is transcribed privately/);
});

test('switching between the three modes keeps one mode per chat, for a group and for a person', async () => {
  const t = tenant();
  for (const [action, chat, mode] of [['private', CLUB, 'private'], ['exclude', CLUB, 'off'], ['include', CLUB, 'included'], ['private', CLUB, 'private'],
    ['exclude', RON, 'off'], ['private', RON, 'private'], ['include', RON, 'included']]) {
    await t.applySwitch({ chatId: chat, ids: [chat], name: 'x', isGroup: chat.endsWith('@g.us') }, action);
    exclusive(t, [CLUB, RON]); assert.equal(t.chatMode(chat), mode, `${action} → ${mode}`);
  }
});

test('in private mode every recording, mine included, comes to the control group only', async () => {
  const t = tenant();
  await t.applySwitch({ chatId: RON, ids: [RON], name: 'Ron Levi', isGroup: false }, 'private');
  t.out.length = 0;
  await t.onMessage(recording(RON), t.sock);
  assert.equal(t.out.length, 1);
  assert.equal(t.out[0].jid, CONTROL); assert.equal(t.out[0].quoted, false, 'a message of its own, no quote');
  assert.equal(t.out[0].text, '🎙️ *Ron*\n*Running late*\nI will be there at eight.');
  assert.deepEqual(t.fwdMap.get(`S${seq}`), { chatId: RON, name: 'Ron' }, 'the private copy can be replied to, to switch the chat');
  t.out.length = 0;
  await t.onMessage(recording(RON, { fromMe: true }), t.sock);
  assert.equal(t.out.length, 1); assert.equal(t.out[0].jid, CONTROL, 'my own note stays out of the chat too');
  assert.match(t.out[0].text, /^🎙️ \*You\* to \*Ron\*\n/);
});

test('a group in private mode: the copy names the sender and the group', async () => {
  const t = tenant(); t.groupNames.set(CLUB, 'Book club');
  await t.applySwitch({ chatId: CLUB, ids: [CLUB], name: 'Book club', isGroup: true }, 'private');
  t.out.length = 0;
  await t.onMessage(recording(CLUB, { participant: '777@s.whatsapp.net' }), t.sock);
  assert.equal(t.out.length, 1); assert.equal(t.out[0].jid, CONTROL);
  assert.match(t.out[0].text, /^🎙️ \*Ron\* in \*Book club\*\n/);
});

test('replying private to a forwarded recording\'s text switches that chat', async () => {
  const t = tenant();
  t.recordFwd('P1', { chatId: RON, name: 'Ron Levi' });
  assert.equal(await say(t, 'private', 'P1'), true);
  assert.match(t.out.at(-1).text, /privately\?/);
  assert.equal(await say(t, 'yes'), true);
  assert.equal(t.chatMode(RON), 'private');
});

test('private mode survives a restart', async () => {
  const t = tenant('pv-persist');
  await t.applySwitch({ chatId: RON, ids: [RON], name: 'Ron Levi', isGroup: false }, 'private');
  const again = new Tenant({ id: 'pv-persist', createdAt: Date.now() }, t.dir);
  assert.ok(again.quiet.has(RON)); assert.equal(again.chatMode(RON), 'private');
});

test('a disappearing chat in private mode: no copy is made, so none outlives the recording', async () => {
  const t = tenant();
  await t.applySwitch({ chatId: RON, ids: [RON], name: 'Ron Levi', isGroup: false }, 'private');
  t.out.length = 0;
  await t.onMessage(recording(RON, { expiration: 86400 }), t.sock);
  assert.deepEqual(t.transcribed, []); assert.equal(t.out.length, 0);
});

test('the log says only that a private transcript went out — no names, no text', async () => {
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    const t = tenant();
    await t.applySwitch({ chatId: RON, ids: [RON], name: 'Ron Levi', isGroup: false }, 'private');
    await t.onMessage(recording(RON), t.sock);
  } finally { console.log = orig; }
  assert.ok(lines.some((l) => /📝 private transcript \(private\)/.test(l)));
  assert.ok(!lines.some((l) => /Ron|eight|Running/.test(l)), lines.join('\n'));
});

test('a private copy does not stand in for the text in the chat: another account here still posts there', async () => {
  const ben = tenant(), carmel = tenant();
  await ben.applySwitch({ chatId: CLUB, ids: [CLUB], name: 'Book club', isGroup: true }, 'private');
  await carmel.applySwitch({ chatId: CLUB, ids: [CLUB], name: 'Book club', isGroup: true }, 'include');
  ben.out.length = 0; carmel.out.length = 0;
  const msg = recording(CLUB, { participant: '777@s.whatsapp.net', id: 'SHARED' });
  await Promise.all([ben.onMessage(msg, ben.sock), carmel.onMessage(msg, carmel.sock)]);
  assert.deepEqual(ben.out.map((o) => o.jid), [CONTROL], 'Ben gets his private copy');
  assert.deepEqual(carmel.out.map((o) => o.jid), [CLUB, CLUB], 'Carmel still posts in the group');
  assert.equal(carmel.out[1].react?.text, '🎙️', 'and marks the recording');
});

test('the Hebrew texts open every line with a Hebrew letter; help and the status list name private', async () => {
  const t = tenant(); t.locale = 'he';
  await say(t, 'private Ron'); await say(t, 'yes'); await say(t, 'private');
  const texts = [...t.out.map((o) => o.text), t.helpText(), t.welcomeText()];
  for (const line of texts.flatMap((x) => x.split('\n')).filter((l) => l.trim())) { const first = line.match(/\p{L}/u)?.[0]; if (first) assert.match(first, /[֐-׿]/, line); }
  assert.match(t.out.at(-1).text, /מתומללים בפרטיות: Ron Levi/);
  assert.match(t.helpText(), /\*private\*/);
});

test('my own note in a group in private mode: the copy says where it went; in Hebrew too', async () => {
  const t = tenant(); t.groupNames.set(CLUB, 'Book club');
  await t.applySwitch({ chatId: CLUB, ids: [CLUB], name: 'Book club', isGroup: true }, 'private');
  t.out.length = 0;
  await t.onMessage(recording(CLUB, { fromMe: true }), t.sock);
  assert.equal(t.out.length, 1); assert.equal(t.out[0].jid, CONTROL); assert.match(t.out[0].text, /^🎙️ \*You\* in \*Book club\*\n/);
  t.locale = 'he'; t.out.length = 0;
  await t.onMessage(recording(CLUB, { fromMe: true }), t.sock);
  assert.match(t.out[0].text, /^🎙️ ההקלטה שלך ב\*Book club\*\n/);
});

