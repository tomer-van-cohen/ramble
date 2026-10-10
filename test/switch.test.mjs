// node --test test/switch.test.mjs — include / exclude a chat by name from the control group:
// nothing changes before an explicit yes, same-name people stay apart, both ids of a person switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-switch-'));
const { Tenant } = await import('../src/tenant.js');

const CONTROL = '999@g.us';
// Invented contacts: two different people saved under the same name, one person under two ids.
const contacts = new Map([
  ['111@s.whatsapp.net', 'Dana Cohen'],
  ['222@s.whatsapp.net', 'Dana Cohen'],
  ['333@s.whatsapp.net', 'אמא'],
  ['9001@lid', 'אמא'],
  ['444@s.whatsapp.net', 'Ron Levi'],
]);
const groups = { '555@g.us': { subject: 'Book club' }, '666@g.us': { subject: 'Dana birthday' }, [CONTROL]: { subject: 'Ramble' } };
const lids = new Map([['333@s.whatsapp.net', '9001@lid']]);

function tenant() {
  const t = new Tenant({ id: `sw${Math.random()}`.replace('.', ''), createdAt: Date.now() }, join(process.env.DATA_DIR, `sw${Math.random()}`));
  t.target = { jid: CONTROL, name: 'Ramble' };
  t.contactNames = new Map(contacts);
  const out = []; let seq = 0;
  t.sendPaced = async (jid, content) => { out.push({ jid, ...content }); return { key: { id: `S${++seq}` } }; };
  t.sock = {
    sendMessage: async () => ({ key: { id: `S${++seq}` } }),
    groupFetchAllParticipating: async () => groups,
    signalRepository: { lidMapping: {
      getLIDForPN: async (pn) => lids.get(pn) || null,
      getPNForLID: async (lid) => [...lids].find(([, l]) => l === lid)?.[0] || null,
    } },
  };
  t.out = out;
  return t;
}
const say = (t, body, quotedId = null) => {
  const key = { remoteJid: CONTROL, fromMe: true, id: `T${Math.random()}` };
  const message = quotedId ? { extendedTextMessage: { text: body, contextInfo: { stanzaId: quotedId } } } : { conversation: body };
  return t.handleCommand({ key, message }, t.normalize({ key, message }), 'Ramble');
};
const note = (t, chatId, chatAlt = null) => t.normalize({ key: { remoteJid: chatId, remoteJidAlt: chatAlt, fromMe: true, id: `N${Math.random()}` }, message: { audioMessage: { ptt: true, seconds: 3, fileSha256: Buffer.from('x') } } });

test('one match: the chat is named with the end of its number, and nothing changes until yes', async () => {
  const t = tenant();
  assert.equal(await say(t, 'exclude Ron'), true);
  assert.match(t.out[0].text, /Exclude \*Ron Levi \(…444\)\*\?/); assert.match(t.out[0].text, /your own voice notes included/);
  assert.equal(t.muted.size, 0, 'asking changes nothing');
  assert.equal(await say(t, 'ok'), false, 'only yes applies');
  assert.equal(await say(t, 'yes'), true);
  assert.ok(t.muted.has('444@s.whatsapp.net'));
  assert.match(t.out.at(-1).text, /Done: \*Ron Levi\* is excluded/);
  assert.equal(await say(t, 'yes'), false, 'the question was answered');
});

test('several matches: a list, a number picks, and the pick is still confirmed; no cancels', async () => {
  const t = tenant();
  await say(t, 'exclude Dana');
  const ask = t.out[0].text;
  assert.match(ask, /Which one\?/);
  assert.match(ask, /Dana Cohen \(…111\)/); assert.match(ask, /Dana Cohen \(…222\)/, 'two people with one name stay apart');
  assert.match(ask, /Dana birthday \(group\)/, 'groups are found by name too');
  assert.ok(!/Ramble/.test(ask), 'never the control group');
  assert.equal(await say(t, 'yes'), false, 'yes means nothing before a pick');
  assert.equal(await say(t, '9'), false, 'not a listed number');
  const lines = ask.split('\n'); const n = lines.findIndex((l) => l.includes('…222'));
  assert.equal(await say(t, lines[n].split('.')[0]), true);
  assert.match(t.out.at(-1).text, /Exclude \*Dana Cohen \(…222\)\*\?/);
  assert.equal(t.muted.size, 0, 'picking changes nothing');
  assert.equal(await say(t, 'no'), true);
  assert.match(t.out.at(-1).text, /Nothing changed/);
  assert.equal(t.muted.size, 0);
  assert.equal(await say(t, 'yes'), false, 'nothing open any more');
});

test('a person is excluded under both ids, and their chat stays silent whichever id a note arrives with — the owner\'s own notes included', async () => {
  const t = tenant();
  await say(t, 'exclude אמא');
  assert.match(t.out[0].text, /אמא \(…333\)/); assert.ok(!/Which one/.test(t.out[0].text), 'the phone id and the lid are one person');
  await say(t, 'yes');
  assert.ok(t.muted.has('333@s.whatsapp.net') && t.muted.has('9001@lid'));
  assert.equal(t.isExcluded(note(t, '333@s.whatsapp.net')), true);
  assert.equal(t.isExcluded(note(t, '9001@lid')), true);
  assert.equal(t.isExcluded(note(t, '777@lid', '333@s.whatsapp.net')), true, 'the alternate id WhatsApp sends along counts');
  assert.equal(t.isExcluded(note(t, '444@s.whatsapp.net')), false);
  await say(t, 'include אמא'); await say(t, 'yes');
  assert.equal(t.muted.size, 0, 'include brings both ids back');
});

test('a group: include turns it on after a yes; exclude turns it off for everyone, the owner too', async () => {
  const t = tenant();
  await say(t, 'include Book club');
  assert.match(t.out[0].text, /Transcribe \*Book club \(group\)\*\?/);
  assert.equal(t.enabled.size, 0);
  await say(t, 'yes');
  assert.ok(t.enabled.has('555@g.us')); assert.equal(t.chatIncluded('555@g.us'), true);
  await say(t, 'exclude Book club'); await say(t, 'yes');
  assert.equal(t.chatIncluded('555@g.us'), false); assert.equal(t.isExcluded(note(t, '555@g.us')), true);
});

test('as a reply to a forwarded recording: the chat is known, and it still asks', async () => {
  const t = tenant();
  t.recordFwd('P1', { chatId: '444@s.whatsapp.net', name: 'Ron Levi' });
  assert.equal(await say(t, 'exclude', 'P1'), true);
  assert.match(t.out[0].text, /Exclude \*Ron Levi \(…444\)\*\?/);
  assert.equal(t.muted.size, 0);
  await say(t, 'yes');
  assert.ok(t.muted.has('444@s.whatsapp.net'));
});

test('no match, an expired question, and the bare word: nothing changes', async () => {
  const t = tenant();
  await say(t, 'exclude Yossi');
  assert.match(t.out[0].text, /No contact or group called \*Yossi\*/); assert.equal(t.pendingSwitch, null);
  await say(t, 'exclude Ron'); t.pendingSwitch.at -= 11 * 60e3;
  assert.equal(await say(t, 'yes'), false); assert.equal(t.muted.size, 0);
  await say(t, 'exclude');
  assert.match(t.out.at(-1).text, /No chat is excluded/);
  assert.equal(await say(t, 'off'), false, 'the old words are gone');
});

test('the newest question owns the yes: a switch question drops a waiting leave, and leave drops a switch', async () => {
  const t = tenant(); let left = 0; t.onLeave = async () => { left++; };
  await say(t, 'leave'); await say(t, 'exclude Ron'); await say(t, 'yes');
  assert.equal(left, 0); assert.ok(t.muted.has('444@s.whatsapp.net'));
  await say(t, 'include Ron'); await say(t, 'leave'); await say(t, 'no');
  assert.ok(t.muted.has('444@s.whatsapp.net'), 'the no answered the leave; the include was dropped');
});

test('Hebrew: every line of the questions and answers opens with a Hebrew letter', async () => {
  const t = tenant(); t.locale = 'he';
  await say(t, 'exclude אמא'); await say(t, 'yes'); await say(t, 'include אמא'); await say(t, 'no'); await say(t, 'exclude'); await say(t, 'include');
  for (const line of t.out.flatMap((o) => o.text.split('\n')).filter((l) => l.trim())) assert.match(line.match(/\p{L}/u)[0], /[֐-׿]/, line);
});

test('a business that is not a saved contact is found by the name the chat list shows, whatever the case', async () => {
  const t = tenant();
  t.onChats([{ id: '888@s.whatsapp.net', name: 'Sunrise Bakery', pnJid: '888@s.whatsapp.net', lidJid: '8801@lid' }]);
  await say(t, 'exclude sunrise bakery');
  assert.match(t.out[0].text, /Exclude \*Sunrise Bakery \(…888\)\*\?/);
  await say(t, 'yes');
  assert.ok(t.muted.has('888@s.whatsapp.net') && t.muted.has('8801@lid'), 'the lid the chat came with is switched too');
});

test('a chat-list name never overwrites a name the owner saved', () => {
  const t = tenant(); t.savedNames = new Set(['444@s.whatsapp.net']);
  t.onChats([{ id: '444@s.whatsapp.net', name: 'Something Else' }]);
  assert.equal(t.contactNames.get('444@s.whatsapp.net'), 'Ron Levi');
});

test('a business\'s verified name on its message is learnt', async () => {
  const t = tenant();
  const m = { key: { remoteJid: '889@s.whatsapp.net', fromMe: false, id: 'B1' }, verifiedBizName: 'Corner Garage', message: { conversation: 'your car is ready' } };
  await t.onMessage(m, t.sock);
  assert.equal(t.contactNames.get('889@s.whatsapp.net'), 'Corner Garage');
});

test('by number: a known chat whose number ends the same way, or one WhatsApp confirms — and it still asks', async () => {
  const t = tenant(); t.ownId = '972500000001@s.whatsapp.net'; t.locale = 'en';
  t.contactNames.set('972541112233@s.whatsapp.net', 'Plumber');
  await say(t, 'exclude 054-111-2233');
  assert.match(t.out.at(-1).text, /Exclude \*Plumber \(…2233\)\*\?/); assert.equal(t.muted.size, 0);
  await say(t, 'no');
  let asked = null; t.sock.onWhatsApp = async (num) => { asked = num; return [{ exists: true, jid: '972529998877@s.whatsapp.net' }]; };
  await say(t, 'exclude 052-999-8877');
  assert.equal(asked, '972529998877', 'a local number takes the owner\'s country code');
  assert.match(t.out.at(-1).text, /Exclude \*\+972529998877 \(…8877\)\*\?/);
  await say(t, 'yes'); assert.ok(t.muted.has('972529998877@s.whatsapp.net'));
  t.sock.onWhatsApp = async () => [{ exists: false }];
  await say(t, 'exclude +44 7700 900000');
  assert.match(t.out.at(-1).text, /No contact or group called/); assert.match(t.out.at(-1).text, /Write the number instead/);
});

test('a person is listed once, under the name the owner saved, even when they gave themselves another', async () => {
  const t = tenant();
  // Saved as "Noam" on the phone id; the lid carries the name they chose for themselves.
  t.contactNames = new Map([['972500000001@s.whatsapp.net', 'Noam'], ['1001@lid', 'Noam Barak'], ['972500000002@s.whatsapp.net', 'Noam Peretz']]);
  t.savedNames = new Set(['972500000001@s.whatsapp.net', '972500000002@s.whatsapp.net']);
  lids.set('972500000001@s.whatsapp.net', '1001@lid');
  try {
    const options = await t.switchOptions('Noam');
    const labels = options.map((o) => t.switchLabel(o));
    assert.deepEqual(labels.sort(), ['Noam (…0001)', 'Noam Peretz (…0002)'], labels.join(' | '));
    const noam = options.find((o) => o.ids.includes('1001@lid'));
    assert.ok(noam.ids.includes('972500000001@s.whatsapp.net'), 'both ids of the one person switch together');
  } finally { lids.delete('972500000001@s.whatsapp.net'); }
});

test('a voice note arriving under the lid keeps the saved name; the self-chosen one does not overwrite it', async () => {
  const t = tenant();
  t.contactNames = new Map([['972500000001@s.whatsapp.net', 'Noam']]); t.savedNames = new Set(['972500000001@s.whatsapp.net']);
  const m = { key: { remoteJid: '1001@lid', remoteJidAlt: '972500000001@s.whatsapp.net', fromMe: false, id: 'L1' }, pushName: 'Noam Barak', message: { conversation: 'hi' } };
  await t.onMessage(m, t.sock);
  assert.equal(t.contactNames.get('1001@lid'), 'Noam');
});
