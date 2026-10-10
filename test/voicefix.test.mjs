// node --test test/voicefix.test.mjs — corrections by voice (a pilot): a spoken reply to our transcript, from
// whoever spoke the original, edits the transcript in place. Invented chats and names; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-voicefix-'));
process.env.CLAIM_YIELD_MS = '5';
const { Tenant } = await import('../src/tenant.js');
const { brain } = await import('../src/brain/index.js');

const FRIEND = '444@s.whatsapp.net', OTHER = '555@s.whatsapp.net';
let seq = 0;
function tenant(rec = {}) {
  const id = `f${++seq}`;
  const t = new Tenant({ id, createdAt: Date.now(), voiceFix: true, ...rec }, join(process.env.DATA_DIR, id));
  t.target = { jid: '999@g.us', name: 'Ramble' };
  t.out = []; t.worked = [];
  t.sendPaced = async (jid, content) => { t.out.push({ jid, ...content }); return { key: { id: `S${++seq}`, remoteJid: jid, fromMe: true } }; };
  t.handleRecording = async (m, n) => { t.worked.push(n.fixOf ? 'fix' : 'plain'); return true; };
  t.sock = {};
  return t;
}
const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 3, ptt: true };
const voice = (t, { chat = FRIEND, fromMe = false, quoted = null } = {}) => {
  const id = `V${++seq}`;
  const audioMessage = { ...node, fileSha256: Buffer.from(id), ...(quoted ? { contextInfo: { stanzaId: quoted, participant: '999000@s.whatsapp.net' } } : {}) };
  return t.onMessage({ key: { remoteJid: chat, fromMe, id }, messageTimestamp: Math.floor(Date.now() / 1000), message: { audioMessage } }, t.sock);
};
// Our transcript of a recording, as deliver() posts it.
async function posted(t, { fromMe = false, chat = FRIEND, text = 'ראיתי שלום מוזר' } = {}) {
  const n = { id: `R${++seq}`, chatId: chat, fromMe, isGroup: false, senderIds: fromMe ? [] : [chat], senderName: 'Dana', route: 'chat' };
  await t.deliver(n, 'Dana', text, false, null);
  return t.out.at(-1);
}

test('a spoken reply to the transcript, from the one who spoke it, is routed to the correction', async () => {
  const t = tenant(); const theirs = await posted(t);
  const id = [...t.fixable.keys()].at(-1);
  await voice(t, { quoted: id });                       // the other side corrects their own transcript
  const mine = await posted(t, { fromMe: true }); const myId = [...t.fixable.keys()].at(-1);
  await voice(t, { fromMe: true, quoted: myId });       // the owner corrects theirs
  assert.deepEqual(t.worked, ['fix', 'fix']);
  assert.match(theirs.text, /^🎙️ \*Dana\*: /); assert.ok(mine.text.endsWith('ראיתי שלום מוזר'));
});

test('anyone else, another chat, no reply, or too late: an ordinary recording', async () => {
  const t = tenant(); await posted(t); const id = [...t.fixable.keys()].at(-1);
  await voice(t, { fromMe: true, quoted: id });          // the owner, on the other side's transcript
  await voice(t, { chat: OTHER, quoted: id });           // another chat
  await voice(t);                                        // not a reply
  t.fixable.get(id).at -= 15 * 60e3; await voice(t, { quoted: id }); // past WhatsApp's edit window
  assert.deepEqual(t.worked, ['plain', 'plain', 'plain', 'plain']);
});

test('off unless an admin turned it on: nothing is even remembered', async () => {
  const t = tenant({ voiceFix: false }); await posted(t);
  assert.equal(t.fixable.size, 0);
});

test('a correction edits our post in place, with its prefix; "not a correction" changes nothing', async () => {
  const t = tenant(); await posted(t); const p = [...t.fixable.values()].at(-1);
  const saved = brain.amend;
  try {
    brain.amend = async (original, reply) => (/חלום/.test(reply) ? { text: original.replace('שלום', 'חלום') } : null);
    const correction = { key: { remoteJid: FRIEND, id: 'C1', fromMe: false } };
    assert.equal(await t.amendPost(p, 'לא אמרתי שלום, אמרתי חלום', { id: 'x', fromMe: false, seconds: 3 }, correction), true);
    await new Promise((r) => setImmediate(r));
    const [edit, mark] = t.out.slice(-2);
    assert.deepEqual(edit.edit, p.key); assert.equal(edit.text, '🎙️ *Dana*: ראיתי חלום מוזר');
    assert.deepEqual(mark.react, { text: '✏️', key: correction.key }, 'the correction gets a mark');
    assert.equal(p.raw, null, 'the old reading is dropped once the speaker has said what it is');
    const before = t.out.length;
    assert.equal(await t.amendPost(p, 'כן, מחר בערב מתאים לי', { id: 'y', fromMe: false, seconds: 3 }), false);
    assert.equal(t.out.length, before, 'nothing sent: the reply is delivered as a recording instead');
  } finally { brain.amend = saved; }
});

test('the recogniser\'s own text goes to the correction with the post', async () => {
  const t = tenant(); const saved = brain.amend; let seen = null;
  try {
    brain.amend = async (original, reply, ctx) => { seen = ctx.raw; return null; };
    const n = { id: 'R1', chatId: FRIEND, fromMe: true, isGroup: false, senderIds: [], senderName: 'Me', route: 'chat', rawText: 'ראיתי חלום מוזר' };
    await t.deliver(n, 'Dana', 'ראיתי שלום מוזר', false, null);
    await t.amendPost([...t.fixable.values()].at(-1), 'לא שלום, חלום', { id: 'x', fromMe: true, seconds: 2 });
    assert.equal(seen, 'ראיתי חלום מוזר');
  } finally { brain.amend = saved; }
});

test('server-wide switch: every account, without turning each on, and kept on disk', async () => {
  const { setFeature, feature, _reset } = await import('../src/features.js');
  const t = tenant({ voiceFix: false });
  await posted(t); assert.equal(t.fixable.size, 0);
  setFeature('voiceFixAll', true); _reset();
  assert.equal(feature('voiceFixAll'), true, 'read back from DATA_DIR/features.json');
  await posted(t); const id = [...t.fixable.keys()].at(-1);
  await voice(t, { quoted: id });
  assert.deepEqual(t.worked, ['fix']);
  setFeature('voiceFixAll', false);
  assert.throws(() => setFeature('everything', true), /no such feature/);
});

test('numbers for the summary, no text: words changed, and which stage had it wrong', async () => {
  const { correctionStats, summarizeVoiceFix } = await import('../src/experiments.js');
  assert.deepEqual(correctionStats('ראיתי שלום מוזר', 'ראיתי חלום מוזר', 'ראיתי חלום מוזר'), { changed: 1, added: 1, stage: 'cleanup' }, 'the recogniser had it right');
  assert.deepEqual(correctionStats('ראיתי שלום מוזר', 'ראיתי חלום מוזר', 'ראיתי שלום מוזר'), { changed: 1, added: 1, stage: 'recognition' });
  assert.equal(correctionStats('נפגש ביום שני', 'נפגש ביום שלישי', null).stage, 'recognition', 'no clean-up ran');
  const s = summarizeVoiceFix([
    { kind: 'voicefix', outcome: 'fixed', acct: 'a', own: true, gap: 20, changed: 1, stage: 'cleanup' },
    { kind: 'voicefix', outcome: 'fixed', acct: 'b', own: false, gap: 40, changed: 2, stage: 'recognition' },
    { kind: 'voicefix', outcome: 'not-a-correction', acct: 'a', gap: 5 }, { kind: 'recording', arm: 'A' },
  ]);
  assert.deepEqual(s, { replies: 3, fixed: 2, notACorrection: 1, editFailed: 0, accounts: 2, own: 1, others: 1, gapMedian: 40, wordsChangedMedian: 2, recognition: 1, cleanup: 1 });
  assert.ok(!JSON.stringify(s).match(/[֐-׿]/), 'no words in the summary');
});

test('the texts go beside the kept recording, only for an account that keeps recordings', async () => {
  const research = await import('../src/research.js');
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const saved = brain.amend;
  try {
    brain.amend = async (original) => ({ text: original.replace('שלום', 'חלום') });
    for (const keepAudio of [true, false]) {
      const t = tenant({ keepAudio });
      const n = { id: `R${++seq}`, chatId: FRIEND, fromMe: true, isGroup: false, senderIds: [], senderName: 'Me', route: 'chat', rawText: 'ראיתי חלום מוזר' };
      await t.deliver(n, 'Dana', 'ראיתי שלום מוזר', false, null);
      const tmp = join(process.env.DATA_DIR, `a${seq}.ogg`); writeFileSync(tmp, 'x');
      const item = research.archive({ accountId: t.id, mediaPath: tmp, meta: { seconds: 3 } });
      t.fixable.get(n.fixKey).item = item;
      await t.amendPost(t.fixable.get(n.fixKey), 'לא שלום, חלום', { id: 'z', fromMe: true, seconds: 2 });
      const meta = research.list(t.id)[0];
      if (keepAudio) assert.deepEqual(meta.corrections.map((c) => [c.before, c.raw, c.after, c.reply, c.stage]), [['ראיתי שלום מוזר', 'ראיתי חלום מוזר', 'ראיתי חלום מוזר', 'לא שלום, חלום', 'cleanup']]);
      else assert.equal(meta.corrections, undefined, 'nothing written for an account that does not keep recordings');
    }
  } finally { brain.amend = saved; }
});

test('a recording whose text went into the chat gets the 🎙️ mark; one whose text came privately gets nothing', async () => {
  const { setSetting, _reset } = await import('../src/features.js');
  _reset();
  const t = tenant(); const original = { key: { remoteJid: FRIEND, id: 'REC1', fromMe: false } };
  const n = { id: 'REC1', chatId: FRIEND, fromMe: false, isGroup: false, senderIds: [FRIEND], senderName: 'Dana', route: 'chat' };
  await t.deliver(n, 'Dana', 'שלום', false, original); await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.out.at(-1).react, { text: '🎙️', key: original.key });
  const before = t.out.length;
  await t.deliver({ ...n, id: 'REC2', route: 'me' }, 'Dana', 'שלום', false, { key: { ...original.key, id: 'REC2' } }); await new Promise((r) => setImmediate(r));
  assert.equal(t.out.length, before + 1, 'private: the text to the Ramble group, nothing in the chat');
  assert.equal(t.out.at(-1).jid, '999@g.us'); assert.equal(t.out.at(-1).react, undefined);
  setSetting('transcribedReaction', '');
  await t.deliver({ ...n, id: 'REC3' }, 'Dana', 'שלום', false, { key: { ...original.key, id: 'REC3' } }); await new Promise((r) => setImmediate(r));
  assert.equal(t.out.at(-1).react, undefined, 'empty = no mark');
  setSetting('transcribedReaction', '🗣️'); _reset();
  await t.deliver({ ...n, id: 'REC4' }, 'Dana', 'שלום', false, { key: { ...original.key, id: 'REC4' } }); await new Promise((r) => setImmediate(r));
  assert.equal(t.out.at(-1).react.text, '🗣️', 'changed from the admin page, read back from disk');
  setSetting('transcribedReaction', '🎙️');
});

test('a mark is one emoji or none', async () => {
  const { setSetting, validEmoji } = await import('../src/features.js');
  for (const ok of ['', '✏️', '🎙️', '👍🏽', '🏳️‍🌈']) assert.ok(validEmoji(ok), ok);
  for (const bad of ['ok', 'a✏️', '✏️ ok', '<b>', '12']) assert.ok(!validEmoji(bad), bad);
  assert.throws(() => setSetting('fixReaction', 'done'), /one emoji/);
  assert.throws(() => setSetting('anything', '✏️'), /no such setting/);
});

test('our own 🎙️ is not counted as someone reacting to the recording', async () => {
  const t = tenant();
  const id = 'OWNMARK';
  t.sendPaced = async (jid, content) => { t.out.push({ jid, ...content }); return { key: { id, remoteJid: jid, fromMe: true } }; };
  await t.sendMark(FRIEND, '🎙️', { remoteJid: FRIEND, id: 'REC9', fromMe: false });
  assert.ok(t.ownMarks.has(id));
  t.abRecs.set('REC9', { arm: 'A', at: Date.now(), chatId: FRIEND });
  const said = []; const log = console.log; console.log = (l) => said.push(String(l));
  process.env.AB_SHARE_B = '0.1'; // the experiment is on, so reactions are counted
  try {
    t.noteSignal({ key: { remoteJid: FRIEND, fromMe: true, id }, message: { reactionMessage: { key: { id: 'REC9' }, text: '🎙️' } } }, null);
    assert.ok(!said.some((l) => /🧪 react/.test(l)), 'ours: not recorded as a reaction');
    t.noteSignal({ key: { remoteJid: FRIEND, fromMe: false, id: 'THEIRS' }, message: { reactionMessage: { key: { id: 'REC9' }, text: '😂' } } }, null);
    assert.ok(said.some((l) => /🧪 react .*emoji=😂/.test(l)), 'someone else\'s: recorded');
  } finally { console.log = log; delete process.env.AB_SHARE_B; }
});

test('a typed reply from the speaker corrects too; a long text reply, or someone else\'s, does not reach the model', async () => {
  const t = tenant(); await posted(t); const id = [...t.fixable.keys()].at(-1);
  const saved = brain.amend; const asked = [];
  try {
    brain.amend = async (original, reply) => { asked.push(reply); return { text: original.replace('שלום', 'חלום') }; };
    const typed = (body, fromMe = false, chat = FRIEND) => t.onMessage({ key: { remoteJid: chat, fromMe, id: `T${++seq}` }, messageTimestamp: Math.floor(Date.now() / 1000), message: { extendedTextMessage: { text: body, contextInfo: { stanzaId: id } } } }, t.sock);
    await typed('חלום, לא שלום');
    assert.deepEqual(asked, ['חלום, לא שלום']);
    assert.equal(t.out.at(-2).text, '🎙️ *Dana*: ראיתי חלום מוזר'); assert.deepEqual(t.out.at(-2).edit, t.fixable.get(id).key);
    await typed('חלום, לא שלום', true);                       // the owner, on the other side's transcript
    await typed(Array.from({ length: 40 }, () => 'מילה').join(' ')); // a message, not a fix
    assert.equal(asked.length, 1);
  } finally { brain.amend = saved; }
});

test('two corrections in a row both land, each on the text as the one before left it', async () => {
  const t = tenant(); await posted(t, { text: 'ראיתי שלום מוזר אצל דינה' }); const p = [...t.fixable.values()].at(-1);
  const saved = brain.amend;
  try {
    brain.amend = async (original, reply) => { await new Promise((r) => setTimeout(r, reply === 'a' ? 30 : 1)); return { text: reply === 'a' ? original.replace('שלום', 'חלום') : original.replace('דינה', 'דנה') }; };
    const [one, two] = await Promise.all([t.amendPost(p, 'a', { id: 'x1', fromMe: false, seconds: 2 }), t.amendPost(p, 'b', { id: 'x2', fromMe: false, seconds: 2 })]);
    assert.deepEqual([one, two], [true, true]);
    assert.equal(p.body, 'ראיתי חלום מוזר אצל דנה');
    assert.equal(t.out.filter((o) => o.edit).at(-1).text, '🎙️ *Dana*: ראיתי חלום מוזר אצל דנה');
  } finally { brain.amend = saved; }
});

test('a correction that took the post past the window is not edited', async () => {
  const t = tenant(); await posted(t); const p = [...t.fixable.values()].at(-1);
  const saved = brain.amend; const before = t.out.length;
  try {
    brain.amend = async (original) => { p.at -= 13 * 60e3; return { text: original.replace('שלום', 'חלום') }; };
    assert.equal(await t.amendPost(p, 'חלום', { id: 'x', fromMe: false, seconds: 2 }), false);
    assert.equal(t.out.length, before);
  } finally { brain.amend = saved; }
});

test('a correction is counted against the arm and model that made the text, per 1,000 delivered', async () => {
  const { summarize } = await import('../src/experiments.js');
  const t = tenant(); const saved = brain.amend;
  const recs = []; const experiments = await import('../src/experiments.js');
  try {
    brain.amend = async (original) => ({ text: original.replace('שלום', 'חלום') });
    const n = { id: 'RA', chatId: FRIEND, fromMe: true, isGroup: false, senderIds: [], senderName: 'Me', route: 'chat', arm: 'B', model: 'm-b', seconds: 7 };
    await t.deliver(n, 'Dana', 'ראיתי שלום מוזר', false, null);
    const p = t.fixable.get(n.fixKey);
    assert.deepEqual([p.arm, p.model, p.sec], ['B', 'm-b', 7]);
    const rows = summarize([
      ...Array.from({ length: 4 }, () => ({ kind: 'recording', arm: 'B', posted: true, sec: 5 })),
      { kind: 'voicefix', outcome: 'fixed', arm: 'B' }, { kind: 'voicefix', outcome: 'not-a-correction', arm: 'B' },
    ]);
    assert.equal(rows.find((r) => r.arm === 'B' && r.segment === 'all').corrected, 250, 'one fixed of four delivered');
  } finally { brain.amend = saved; }
});
