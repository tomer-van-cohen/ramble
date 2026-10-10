// node --test test/names.test.mjs — which names the correction of a recording is given: what the owner
// taught, the owner and the speaker, and on the owner's own recording the people in that chat; never
// the address book at large, since the text is posted where the speaker reads it. Invented names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-names-'));
const { Tenant } = await import('../src/tenant.js');

const RON = '444@s.whatsapp.net', DANA = '445@s.whatsapp.net', GAL = '446@s.whatsapp.net', CLUB = '555@g.us';
let seq = 0;
function tenant() {
  const id = `nm${++seq}`;
  const t = new Tenant({ id, createdAt: Date.now() }, join(process.env.DATA_DIR, id));
  t.waName = 'Noa Bar';
  t.contactNames = new Map([[RON, 'Ron Levi'], [DANA, 'Dana'], [GAL, 'Gal'], ...Array.from({ length: 50 }, (_, i) => [`9${i}@s.whatsapp.net`, `Contact ${i}`])]);
  t.glossary.add(['Ramble', 'Itamar']);
  t.metaCalls = 0;
  t.sock = { groupMetadata: async () => { t.metaCalls++; return { participants: [{ id: RON }, { id: GAL }, { id: '777@lid' }] }; } };
  return t;
}
const list = (s) => s.split(', ');

test('someone else\'s recording: what the owner taught, the owner, the speaker; in a group, its members; nobody else', async () => {
  const t = tenant();
  const got = list(await t.namesFor({ fromMe: false, chatId: RON, senderIds: [RON], senderName: 'Ronnie', isGroup: false }));
  assert.deepEqual(got.sort(), ['Itamar', 'Noa Bar', 'Ramble', 'Ron Levi', 'Ronnie'].sort());
  const inGroup = list(await t.namesFor({ fromMe: false, chatId: CLUB, senderIds: [GAL], senderName: 'Gal', isGroup: true }));
  assert.ok(inGroup.includes('Ron Levi'), 'the members: they see each other there'); assert.ok(!inGroup.includes('Dana') && !inGroup.some((n) => n.startsWith('Contact')));
});

test('the owner\'s own recording: also the other side of that chat, or the group\'s members, asked of WhatsApp once a week', async () => {
  const t = tenant();
  assert.ok(list(await t.namesFor({ fromMe: true, chatId: DANA, isGroup: false })).includes('Dana'));
  const inGroup = list(await t.namesFor({ fromMe: true, chatId: CLUB, isGroup: true }));
  assert.ok(inGroup.includes('Ron Levi') && inGroup.includes('Gal')); assert.ok(!inGroup.includes('Dana') && !inGroup.some((n) => n.startsWith('Contact')));
  await t.namesFor({ fromMe: true, chatId: CLUB, isGroup: true }); assert.equal(t.metaCalls, 1);
  const forwarded = list(await t.namesFor({ fromMe: true, forwarded: true, chatId: DANA, isGroup: false }));
  assert.ok(!forwarded.includes('Dana'), 'a forwarded recording is someone else\'s voice: no chat names');
});

test('a group WhatsApp does not answer in time costs the names, not the recording', async () => {
  const t = tenant(); t.sock = { groupMetadata: () => new Promise(() => {}) };
  const started = Date.now();
  assert.deepEqual(list(await t.namesFor({ fromMe: true, chatId: CLUB, isGroup: true })).sort(), ['Itamar', 'Noa Bar', 'Ramble']);
  assert.ok(Date.now() - started < 4000);
});
