// node --test test/dictate.test.mjs — dictated messages: contact matching, and the
// send / ask / pick / undo flow on a tenant with a fake socket (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchContacts } from '../src/contacts.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-dictate-'));
const { Tenant } = await import('../src/tenant.js');

const note = 'תשלח לעדן שאני בדרך לאסוף אותה';

const contacts = new Map([
  ['1@s.whatsapp.net', 'עדן כהן'],
  ['1@lid', 'עדן כהן'],            // the same person under her second id
  ['2@s.whatsapp.net', 'David Levi'],
  ['3@s.whatsapp.net', 'אמא'],
  ['5@s.whatsapp.net', 'Dana Cohen'],
  ['6@s.whatsapp.net', 'Ron Cohen'],
]);

test('matching: one person in the best tier is proposed; ids of the same person collapse', () => {
  let r = matchContacts('עדן', contacts);
  assert.equal(r.proposed?.jid, '1@s.whatsapp.net', 'phone id preferred over the lid');
  assert.deepEqual(r.candidates.map((c) => c.name), ['עדן כהן']);
  assert.equal(matchContacts('לעדן', contacts).proposed?.name, 'עדן כהן', 'a leftover ל prefix is tried without');
  assert.equal(matchContacts('david', contacts).proposed?.jid, '2@s.whatsapp.net', 'case-insensitive first name');
  assert.equal(matchContacts('אִמָּא', contacts).proposed?.jid, '3@s.whatsapp.net', 'niqqud ignored');
  assert.equal(matchContacts('Levi', contacts).proposed?.jid, '2@s.whatsapp.net', 'a single other word of the name');
  assert.equal(matchContacts(['דוד', 'David'], contacts).proposed?.jid, '2@s.whatsapp.net', 'a spelling in another script finds a contact saved in it');
  assert.deepEqual(matchContacts('Yossi', contacts), { proposed: null, candidates: [] });
  assert.deepEqual(matchContacts('', contacts), { proposed: null, candidates: [] });
});

test('matching: a regression — a name that only ends in "Noa" must never outrank "Noa 🌻"', () => {
  // A synthetic contact set with the shape of a failure seen in use: the old matcher
  // sent to the one contact flagged as saved, whose LAST word was the spoken name.
  const contacts = new Map([
    ['1001@lid', 'Amit Noa'], ['1002@lid', 'Noa 🌻'], ['1003@lid', 'Noa Yoga Studio 😊🧘🙏🏼'],
    ['1004@lid', 'Noa Levi'], ['1005@lid', 'Noa Mizrahi'], ['1006@lid', 'Noa peretz'],
  ]);
  const r = matchContacts(['נועה', 'Noa'], contacts);
  assert.equal(r.proposed?.name, 'Noa 🌻', 'the whole name beats a first name, which beats another word of a name');
  assert.equal(r.candidates[0].name, 'Noa 🌻');
  assert.equal(r.candidates.at(-1).name, 'Amit Noa', 'the weakest fit is last');
  // the model once answered with a list spelling, emoji included — same result
  assert.equal(matchContacts(['Noa 🌻'], contacts).proposed?.name, 'Noa 🌻');
  // however much the owner writes to Amit, a worse name fit never wins
  assert.equal(matchContacts(['Noa'], contacts, { activity: new Map([['1001@lid', 500]]) }).proposed?.name, 'Noa 🌻');
});

test('matching: inside a tier, the chat the owner writes to most leads — and is proposed only when clearly ahead', () => {
  let r = matchContacts('Cohen', contacts);
  assert.equal(r.proposed, null, 'two people share the word and nothing tells them apart');
  assert.deepEqual(r.candidates.map((c) => c.name).sort(), ['Dana Cohen', 'Ron Cohen']);
  r = matchContacts('Cohen', contacts, { activity: new Map([['6@s.whatsapp.net', 40], ['5@s.whatsapp.net', 2]]) });
  assert.equal(r.proposed?.name, 'Ron Cohen'); assert.equal(r.candidates[0].name, 'Ron Cohen');
  r = matchContacts('Cohen', contacts, { activity: new Map([['6@s.whatsapp.net', 5], ['5@s.whatsapp.net', 4]]) });
  assert.equal(r.proposed, null, 'close counts are not a reason to propose');
  assert.equal(r.candidates[0].name, 'Ron Cohen', 'but they still order the list');
});

// ---- the flow, on a tenant with a fake socket and a stubbed model ----
const CONTROL = 'control@g.us';
function tenant() {
  const t = new Tenant({ id: 'dict', createdAt: Date.now() }, join(process.env.DATA_DIR, 'dict'));
  t.target = { jid: CONTROL, name: 'Readable' };
  t.contactNames = new Map(contacts);
  const out = []; let seq = 0;
  t.sendPaced = async (jid, content, opts = {}) => { out.push({ jid, ...content, quoted: !!opts.quoted }); return { key: { id: `S${++seq}` } }; };
  t.sock = { sendMessage: async (jid, content) => { out.push({ jid, ...content }); return { key: { id: `S${++seq}` } }; } };
  t.out = out;
  return t;
}
const voice = (t, { sha = 'sha1', forwarded = false } = {}) => ({ id: 'V1', chatId: CONTROL, isGroup: true, fromMe: true, isVoice: true, mediaSha: sha, forwarded });
const text = (t, body, quotedId = null) => {
  const key = { remoteJid: CONTROL, fromMe: true, id: `T${Math.random()}` };
  const message = quotedId ? { extendedTextMessage: { text: body, contextInfo: { stanzaId: quotedId } } } : { conversation: body };
  return t.handleCommand({ key, message }, t.normalize({ key, message }), 'Readable');
};

test('even a certain recipient is only proposed: nothing goes out until the owner says yes', async () => {
  const t = tenant();
  t.dictationFor = async () => ({ to: 'עדן', text: 'אני בדרך לאסוף אותך' });
  await t.handleControlNote(voice(t), note, note, false, { key: { id: 'V1' } });
  assert.equal(t.out.length, 1, 'only the question, in the control group');
  assert.equal(t.out[0].jid, CONTROL);
  assert.match(t.out[0].text, /Send to \*עדן כהן \(…1\)\*\?/); assert.match(t.out[0].text, /אני בדרך לאסוף אותך/); assert.ok(!/Someone else/.test(t.out[0].text), 'one match: no list');
  assert.equal(await text(t, 'מה?'), false, 'anything that is not a yes, a no or a number sends nothing');
  assert.equal(t.out.length, 1);
  assert.equal(await text(t, 'כן'), false, 'typed commands are one English word each: no translations');
  assert.equal(await text(t, 'ok'), false, 'and no synonyms');
  assert.equal(await text(t, 'yes'), true);
  assert.deepEqual(t.out[1], { jid: '1@s.whatsapp.net', text: 'אני בדרך לאסוף אותך', quoted: false });
  assert.match(t.out[2].text, /Sent to \*עדן כהן\*/); assert.match(t.out[2].text, /undo/);
  assert.equal(await text(t, 'yes'), false, 'a second yes sends nothing: the question was answered');
  // undo, as a reply to the confirmation: the message is revoked in her chat
  assert.equal(await text(t, 'undo', 'S3'), true);
  assert.deepEqual(t.out[3].delete, { remoteJid: '1@s.whatsapp.net', fromMe: true, id: 'S2' });
  assert.match(t.out[4].text, /Deleted/);
  assert.equal(await text(t, 'undo', 'S3'), false, 'a second undo has nothing to take back');
});

test('a proposed recipient can be declined, or swapped for another match by number', async () => {
  const t = tenant();
  t.activity = new Map([['6@s.whatsapp.net', 40]]); // the owner writes to Ron a lot, so Ron is the proposal
  t.dictationFor = async () => ({ to: 'Cohen', text: 'hi' });
  await t.handleControlNote(voice(t), 'tell Cohen hi', '', false, { key: { id: 'V1' } });
  assert.match(t.out[0].text, /Send to \*Ron Cohen \(…6\)\*\?/); assert.match(t.out[0].text, /1\. Ron Cohen \(…6\)\n2\. Dana Cohen \(…5\)/);
  assert.equal(await text(t, 'no'), true);
  assert.match(t.out.at(-1).text, /Nothing was sent/); assert.equal(t.out.length, 2);
  await t.handleControlNote(voice(t), 'tell Cohen hi', '', false, { key: { id: 'V2' } });
  assert.equal(await text(t, '2'), true);
  assert.deepEqual(t.out.at(-2), { jid: '5@s.whatsapp.net', text: 'hi', quoted: false });
});

test('an ambiguous recipient is asked about; a number sends, cancel drops, and it expires', async () => {
  const t = tenant();
  t.dictationFor = async () => ({ to: 'Cohen', text: 'see you at 8' });
  await t.handleControlNote(voice(t), 'tell Cohen see you at 8', '', false, { key: { id: 'V1' } });
  assert.equal(t.out.length, 1, 'nothing sent to anyone');
  assert.equal(t.out[0].jid, CONTROL); assert.match(t.out[0].text, /1\. .*\n2\. /); assert.match(t.out[0].text, /see you at 8/);
  assert.equal(await text(t, '9'), false, 'not a listed number');
  assert.equal(await text(t, 'yes'), false, 'yes means nothing when nobody was proposed');
  assert.equal(t.out.length, 1);
  assert.equal(await text(t, 'no'), true);
  assert.match(t.out.at(-1).text, /Nothing was sent/);
  assert.equal(await text(t, '1'), false, 'nothing pending any more');
  // ask again, pick by number this time
  await t.handleControlNote(voice(t), 'tell Cohen see you at 8', '', false, { key: { id: 'V2' } });
  const pickable = t.pendingSend.candidates[1];
  assert.equal(await text(t, '2'), true);
  assert.deepEqual(t.out.at(-2), { jid: pickable.jid, text: 'see you at 8', quoted: false });
  assert.match(t.out.at(-1).text, new RegExp(`Sent to \\*${pickable.name}\\*`));
  // expired: a stray number in the control group later is not a pick
  await t.handleControlNote(voice(t), 'tell Cohen see you at 8', '', false, { key: { id: 'V3' } });
  t.pendingSend.at -= 11 * 60e3;
  assert.equal(await text(t, '1'), false);
});

test('no matching contact: nothing is sent, the owner is told', async () => {
  const t = tenant();
  t.dictationFor = async () => ({ to: 'Yossi', text: 'hi' });
  await t.handleControlNote(voice(t), 'tell Yossi hi', '', false, { key: { id: 'V1' } });
  assert.equal(t.out.length, 1); assert.equal(t.out[0].jid, CONTROL); assert.match(t.out[0].text, /nothing was sent/i);
});

test('forwarded or traceable recordings, and notes the model rejects, stay probes — the model is never asked for a forward', async () => {
  const t = tenant();
  let asked = 0; t.dictationFor = async () => { asked++; return { to: 'עדן', text: 'x' }; };
  await t.handleControlNote(voice(t, { forwarded: true }), note, 'body', false, { key: { id: 'V1' } });
  t.mediaSrc.set('known', { chatId: '9@s.whatsapp.net', name: 'Someone' });
  await t.handleControlNote(voice(t, { sha: 'known' }), note, 'body', false, { key: { id: 'V2' } });
  assert.equal(asked, 0);
  t.dictationFor = async () => { asked++; return null; };
  await t.handleControlNote(voice(t), note, 'body', false, { key: { id: 'V3' } });
  assert.equal(asked, 1);
  await t.handleControlNote(voice(t), 'סתם הקלטה בלי שום בקשה', 'body', false, { key: { id: 'V4' } });
  assert.equal(asked, 1, 'no send cue → no model call');
  assert.equal(t.out.length, 4);
  for (const o of t.out) assert.equal(o.jid, CONTROL);
  for (const o of t.out.slice(0, 2)) assert.match(o.text, /forwarded recording|from \*Someone\*/, 'forwarded or traceable: a probe of its chat');
  for (const o of t.out.slice(2)) { assert.ok(!/forwarded recording|Couldn't tell/.test(o.text), 'recorded right here: the owner\'s own note'); assert.equal(o.quoted, true); }
});

test('trace: every step is logged for an account that opted in to keeping data — and nothing for anyone else', async () => {
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    for (const keepAudio of [false, true]) {
      const t = tenant(); t.keepAudio = keepAudio;
      t.dictationFor = async () => ({ to: 'עדן', text: 'אני בדרך לאסוף אותך' });
      await t.handleControlNote(voice(t), note, note, false, { key: { id: 'V1' } });
      await text(t, 'yes');
      const traced = lines.filter((l) => l.includes('🔬'));
      if (!keepAudio) { assert.equal(traced.length, 0, 'not opted in: no content in the logs'); assert.ok(!lines.some((l) => l.includes('עדן'))); }
      else {
        assert.deepEqual(traced.map((l) => l.split(' ')[2]), ['control.note', 'dictation.extracted', 'dictation.match', 'dictation.reply', 'dictation.sent']);
        assert.match(traced[2], /"proposed":\{"jid":"1@s\.whatsapp\.net","name":"עדן כהן","score":2\}/);
        assert.match(traced[4], /"text":"אני בדרך לאסוף אותך"/);
      }
    }
  } finally { console.log = orig; }
});

test('activity: the owner\'s own messages to a private chat are counted (a number, never content); groups and Notes to self are not', async () => {
  const t = tenant(); t.ownId = '972500000000@s.whatsapp.net'; t.sock = { groupMetadata: async () => ({ subject: 'g' }) };
  const send = (remoteJid, fromMe = true) => t.onMessage({ key: { remoteJid, fromMe, id: `A${Math.random()}` }, message: { conversation: 'hi' } }, t.sock);
  await send('5@s.whatsapp.net'); await send('5@s.whatsapp.net'); await send('5@s.whatsapp.net', false);
  await send('group@g.us'); await send(t.ownId);
  assert.deepEqual([...t.activity], [['5@s.whatsapp.net', 2]]);
});

test('a spoken answer counts: "Yes." sends, "לא" drops, "שתיים" picks — and a voice note with no question open stays a plain recording', async () => {
  const t = tenant();
  t.dictationFor = async () => ({ to: 'עדן', text: 'אני כבר בא לאסוף אותך' });
  await t.handleControlNote(voice(t), note, note, false, { key: { id: 'V1' } });
  await t.handleControlNote({ ...voice(t, { sha: 'yes1' }), id: 'V2' }, 'Yes.', 'Yes.', false, { key: { id: 'V2' } }); // production, 2026-09-21: this was posted back as a "forwarded recording"
  assert.deepEqual(t.out[1], { jid: '1@s.whatsapp.net', text: 'אני כבר בא לאסוף אותך', quoted: false });
  assert.match(t.out[2].text, /Sent to/);
  await t.handleControlNote({ ...voice(t, { sha: 'yes2' }), id: 'V3' }, 'Yes.', 'Yes.', false, { key: { id: 'V3' } });
  assert.ok(!/forwarded recording/.test(t.out[3].text), 'nothing pending: just the owner\'s note, with its text'); assert.equal(t.out.length, 4);
  await t.handleControlNote(voice(t), note, note, false, { key: { id: 'V4' } });
  await t.handleControlNote({ ...voice(t, { sha: 'no1' }), id: 'V5' }, 'לא.', 'לא.', false, { key: { id: 'V5' } });
  assert.match(t.out.at(-1).text, /Nothing was sent/);
  t.dictationFor = async () => ({ to: 'Cohen', text: 'hi' });
  await t.handleControlNote(voice(t), 'tell Cohen hi', '', false, { key: { id: 'V6' } });
  const second = t.pendingSend.candidates[1];
  await t.handleControlNote({ ...voice(t, { sha: 'two' }), id: 'V7' }, 'שתיים', 'שתיים', false, { key: { id: 'V7' } });
  assert.deepEqual(t.out.at(-2), { jid: second.jid, text: 'hi', quoted: false });
});

test('our own posts echoing back are never read as an answer', async () => {
  const t = tenant(); t.ownPosts.add('ECHO');
  t.dictationFor = async () => ({ to: 'עדן', text: 'היי' });
  await t.handleControlNote(voice(t), note, note, false, { key: { id: 'V1' } });
  const key = { remoteJid: CONTROL, fromMe: true, id: 'ECHO' }; const message = { conversation: 'yes' };
  assert.equal(await t.handleCommand({ key, message }, t.normalize({ key, message }), 'Readable'), false);
  assert.equal(t.out.length, 1, 'nothing sent'); assert.ok(t.pendingSend, 'the question is still open');
});

// ---- leaving, from the control group ----
test('leave asks first; only a yes erases, and a no changes nothing', async () => {
  const t = tenant(); let left = 0; t.onLeave = async () => { left++; };
  assert.equal(await text(t, 'yes'), false, 'a yes with no question open means nothing');
  assert.equal(await text(t, 'leave'), true);
  assert.match(t.out[0].text, /Unlink \*\w+\* from your WhatsApp and erase/); assert.equal(left, 0);
  assert.equal(await text(t, 'no'), true); assert.match(t.out.at(-1).text, /Nothing changed/);
  assert.equal(await text(t, 'yes'), false, 'the question was answered'); assert.equal(left, 0);
  assert.equal(await text(t, 'Leave'), true);
  assert.equal(await text(t, 'yes'), true);
  assert.equal(left, 1); assert.match(t.out.at(-1).text, /erased/);
});

test('leave speaks Hebrew to a Hebrew owner, and takes a dictation question off the table', async () => {
  const t = tenant(); t.locale = 'he'; let left = 0; t.onLeave = async () => { left++; };
  t.dictationFor = async () => ({ to: 'עדן', text: 'היי' });
  await t.handleControlNote(voice(t), note, note, false, { key: { id: 'V1' } });
  assert.equal(await text(t, 'התנתק'), false, 'the command itself is always the English word');
  assert.equal(await text(t, 'leave'), true);
  assert.match(t.out.at(-1).text, /לנתק את/); assert.match(t.out.at(-1).text, /\*yes\*.*\*no\*/);
  assert.equal(await text(t, 'yes'), true);
  assert.equal(left, 1);
  assert.ok(!t.out.some((o) => o.jid === '1@s.whatsapp.net'), 'the yes was for leaving: nothing was sent to Eden');
});

test('the welcome is short, in the owner\'s language, says the other side sees the text, and leaves the pilot out', () => {
  const t = tenant();
  for (const [setup, re] of [[() => { t.locale = 'en'; }, /^🎉 Welcome to/], [() => { t.locale = 'he'; }, /^🎉 ברוכים הבאים/], [() => { t.locale = ''; t.ownId = '972501234567@s.whatsapp.net'; }, /^🎉 ברוכים הבאים/]]) {
    setup(); const w = t.welcomeText();
    assert.match(w, re); assert.ok(w.length < 450, `${w.length} chars`);
    assert.match(w, /Both of you see the text|לשני הצדדים/, 'it says the text is not only for the owner');
    assert.ok(!/names:|Eden|undo|שמות/.test(w));
    assert.match(w, /\*help\*/, 'without a site address there is no page to send them to');
  }
  t.locale = ''; t.ownId = '15551234567@s.whatsapp.net';
  assert.match(t.welcomeText(), /^🎉 Welcome to \*\w+\*!/);
});

test('help lists the commands, one word each, in the owner\'s language, and leaves the pilot out', async () => {
  const t = tenant();
  assert.equal(await text(t, 'Help'), true);
  for (const w of ['include', 'exclude', 'delete', 'leave', 'help']) assert.match(t.out[0].text, new RegExp(`\\*${w}\\*`));
  assert.ok(!/names|undo|Eden/.test(t.out[0].text));
  t.locale = 'he';
  assert.equal(await text(t, 'help'), true);
  assert.match(t.out[1].text, /הפקודות של/); assert.match(t.out[1].text, /\*leave\*/);
  assert.equal(await text(t, 'עזרה'), false);
});

test('every line of a Hebrew message opens with a Hebrew letter, so WhatsApp lays it out right-to-left', async () => {
  const t = tenant(); t.locale = 'he'; t.onLeave = async () => {};
  await text(t, 'leave'); await text(t, 'no'); await text(t, 'leave'); await text(t, 'yes');
  const texts = [t.welcomeText(), t.helpText(), t.languageReply(), t.languageReply('hebrew'), t.languageReply('auto'), t.languageReply('klingon'), ...t.out.map((o) => o.text)];
  assert.equal(texts.length, 10); assert.match(texts[0], /^🎉 ברוכים הבאים ל-/);
  for (const line of texts.flatMap((x) => x.split('\n')).filter((l) => l.trim())) assert.match(line.match(/\p{L}/u)[0], /[\u0590-\u05FF]/, line);
});

test('language, from the control group: shown, set by name or code, back to auto, and an unknown one changes nothing', async () => {
  const t = tenant(); t.setLanguage('');
  assert.equal(await text(t, 'language'), true);
  assert.match(t.out.at(-1).text, /Transcription language: \*Auto-detect\*/); assert.match(t.out.at(-1).text, /hebrew, english/);
  assert.equal(await text(t, 'Language Hebrew'), true); assert.equal(t.language, 'he'); assert.match(t.out.at(-1).text, /set to \*Hebrew\*/);
  assert.equal(await text(t, 'language: en'), true); assert.equal(t.language, 'en');
  assert.equal(await text(t, 'language klingon'), true); assert.equal(t.language, 'en'); assert.match(t.out.at(-1).text, /don't know/);
  assert.equal(await text(t, 'language auto'), true); assert.equal(t.language, ''); assert.match(t.out.at(-1).text, /auto-detect/);
  assert.equal(await text(t, 'the language here is odd'), false, 'only the command itself');
  t.locale = 'he'; await text(t, 'language');
  assert.match(t.out.at(-1).text, /שפת התמלול: \*זיהוי אוטומטי\*/);
});

test('onboarding ends in the group: the first note recorded there gets its text, then one line on what to do next — once', async () => {
  const t = tenant(); t.linkedAt = Date.now(); t.dictationFor = async () => null;
  const rec = (id) => t.handleControlNote({ ...voice(t), id, mediaSha: `sha-${id}` }, 'בדיקה אחת שתיים', 'בדיקה אחת שתיים', false, { key: { id } });
  await rec('F1');
  assert.equal(t.out.length, 2);
  assert.match(t.out[0].text, /בדיקה אחת שתיים/); assert.ok(!/forwarded|Couldn't tell/.test(t.out[0].text));
  assert.match(t.out[1].text, /That's how it works/); assert.match(t.out[1].text, /private chat/);
  assert.ok(t.firstNoteAt > 0);
  await rec('F2');
  assert.equal(t.out.length, 3, 'the second note just gets its text');
  const old = tenant(); old.linkedAt = Date.now() - 30 * 86400e3; old.dictationFor = async () => null;
  await old.handleControlNote({ ...voice(old), id: 'O1' }, 'x y z', 'x y z', false, { key: { id: 'O1' } });
  assert.equal(old.out.length, 1, 'an account linked long ago is not onboarded again');
});

