// node --test test/settings.test.mjs — the settings page: what is transcribed, whose, and where the text
// goes, by kind of chat; the page and its API; the "settings" command's link. Invented chats throughout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-settings-'));
process.env.CLAIM_YIELD_MS = '5';
process.env.TRUST_PROXY = '0';
process.env.GITHUB_STARS = 'off';
process.env.PUBLIC_URL = 'https://ramble.example';
process.env.ADMIN_PASSWORD = 'admin-secret-for-tests';
const S = await import('../src/settings.js');
const D = await import('../src/door.js');
const { Tenant } = await import('../src/tenant.js');
const registry = await import('../src/registry.js');
const { createWebApp } = await import('../src/web.js');

const CONTROL = '999@g.us', CLUB = '555@g.us', FAMILY = '556@g.us', RON = '444@s.whatsapp.net', RON_LID = '88888@lid', DANA = '445@s.whatsapp.net';
let seq = 0;
function tenant(rec = {}) {
  const id = `st${++seq}`;
  const t = new Tenant({ id, createdAt: Date.now(), ...rec }, join(process.env.DATA_DIR, id));
  t.target = { jid: CONTROL, name: 'Ramble' };
  t.out = []; t.worked = [];
  t.sendPaced = async (jid, content) => { t.out.push({ jid, ...content }); return { key: { id: `S${++seq}` } }; };
  t.handleRecording = async (m, n) => { t.worked.push(`${n.fromMe ? 'mine' : 'theirs'}@${n.chatId}>${n.route}`); return true; };
  t.sock = {};
  return t;
}
const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30, ptt: true };
const rec = (t, chatId, fromMe, alt) => { const id = `V${++seq}`; return t.onMessage({ key: { remoteJid: chatId, fromMe, id, ...(alt ? { remoteJidAlt: alt } : {}), ...(chatId.endsWith('@g.us') && !fromMe ? { participant: '777@s.whatsapp.net' } : {}) }, pushName: 'Someone', message: { audioMessage: { ...node, fileSha256: Buffer.from(id) } } }, t.sock); };
const say = (t, body) => { const key = { remoteJid: CONTROL, fromMe: true, id: `T${++seq}` }; const message = { conversation: body }; return t.handleCommand({ key, message }, t.normalize({ key, message }), 'Ramble'); };
/** Every case at once: my note and theirs, in a private chat and a group. */
async function matrix(t) {
  t.worked = [];
  for (const [chat, fromMe] of [[RON, true], [RON, false], [CLUB, true], [CLUB, false]]) await rec(t, chat, fromMe);
  return t.worked;
}

test('a change is checked field by field: unknown values and ids that are not chats are dropped', () => {
  const s = S.applyPatch(S.defaults(), { where: 'me', chats: { on: 'yes', who: 'nobody', some: [RON, 'x@evil', '<b>@lid', RON, CLUB] }, groups: { on: false, some: [CLUB, RON] }, extra: 1 });
  assert.deepEqual(s.chats, { on: true, who: 'all', where: 'me', some: [RON] });
  assert.deepEqual(s.groups, { on: false, who: 'mine', where: 'me', some: [CLUB] });
  assert.equal(S.whereOf(s), 'me');
  assert.equal(S.whereOf(S.applyPatch(s, { chats: { where: 'chat' } })), 'mixed');
  assert.equal(S.applyPatch(S.defaults(), { chats: { some: Array.from({ length: 400 }, (_, i) => `${10000 + i}@s.whatsapp.net`) } }).chats.some.length, 300);
});

test('an account from before the page keeps what its groups setting meant', () => {
  assert.deepEqual(S.fromLegacy('off').groups, { on: false, who: 'mine', where: 'chat', some: [] });
  assert.deepEqual(S.fromLegacy('mine').groups, { on: true, who: 'mine', where: 'chat', some: [] });
  assert.deepEqual(S.fromLegacy('private').groups, { on: true, who: 'all', where: 'me', some: [] });
  assert.deepEqual(S.fromLegacy(undefined), S.defaults());
  for (const g of ['off', 'mine', 'private']) assert.equal(S.legacyGroups(S.fromLegacy(g)), g, 'and writes it back the same, for a server from before');
});

test('the defaults: everyone\'s voice notes in private chats, my own in groups, all in the chat', async () => {
  assert.deepEqual(await matrix(tenant({ settings: S.defaults() })), [`mine@${RON}>chat`, `theirs@${RON}>chat`, `mine@${CLUB}>chat`]);
});

test('only to me: the same voice notes as in the chat, and every text comes to the control group instead', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { where: 'me' }) });
  assert.deepEqual(await matrix(t), [`mine@${RON}>me`, `theirs@${RON}>me`, `mine@${CLUB}>me`]);
  await t.updateSettings({ groups: { who: 'all' }, chats: { who: 'mine' } });
  assert.deepEqual(await matrix(t), [`mine@${RON}>me`, `mine@${CLUB}>me`, `theirs@${CLUB}>me`]);
  assert.equal(t.groups, 'private'); await t.updateSettings({ groups: { who: 'mine' } }); assert.equal(t.groups, 'mine-private');
  assert.equal(S.legacyGroups(t.settings), 'private', 'a server from before would post nothing in groups either');
  await say(t, 'groups'); assert.match(t.out.at(-1).text, /your own voice notes are transcribed into this group only/);
});

test('a section switched off is silent, mine and theirs; the other one carries on', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { chats: { on: false }, groups: { who: 'all' } }) });
  assert.deepEqual(await matrix(t), [`mine@${CLUB}>chat`, `theirs@${CLUB}>chat`]);
  await t.updateSettings({ groups: { on: false } });
  assert.deepEqual(await matrix(t), []);
});

test('picked chats: only those, under either of a person\'s ids; Notes to self is never left out', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { chats: { some: [RON] }, groups: { some: [FAMILY] } }) });
  t.ownId = '972500000000@s.whatsapp.net';
  assert.deepEqual(await matrix(t), [`mine@${RON}>chat`, `theirs@${RON}>chat`], 'Ron is picked; the book club is not');
  t.worked = []; await rec(t, RON_LID, false, RON); await rec(t, DANA, false); await rec(t, FAMILY, true); await rec(t, t.ownId, true);
  assert.deepEqual(t.worked, [`theirs@${RON_LID}>chat`, `mine@${FAMILY}>chat`, `mine@${t.ownId}>chat`]);
});

test('the switches from WhatsApp still win: excluded is silent, included is everyone\'s in the chat, private comes to me', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { chats: { some: [DANA] } }) });
  t.muted.add(DANA); t.enabled.add(RON); t.quiet.add(CLUB);
  t.worked = []; await rec(t, DANA, true); await rec(t, RON, false); await rec(t, CLUB, false);
  assert.deepEqual(t.worked, [`theirs@${RON}>chat`, `theirs@${CLUB}>me`]);
});

test('choosing "only to me" on the page moves the chats included from WhatsApp to private mode, so nothing is posted', async () => {
  const t = tenant(); t.enabled.add(CLUB); t.enabled.add(RON);
  const view = await t.updateSettings({ where: 'me' });
  assert.equal(view.where, 'me');
  assert.equal(t.enabled.size, 0); assert.ok(t.quiet.has(CLUB) && t.quiet.has(RON));
  assert.deepEqual(await matrix(t), [`mine@${RON}>me`, `theirs@${RON}>me`, `mine@${CLUB}>me`, `theirs@${CLUB}>me`], 'the included group is everyone\'s, now to me');
  const back = new Tenant(JSON.parse(readFileSync(join(t.dir, 'tenant.json'), 'utf8')), t.dir);
  assert.equal(S.whereOf(back.settings), 'me', 'saved with the account');
});

test('the groups command speaks the same model: off, mine, all, private', async () => {
  const t = tenant();
  for (const [word, want] of [['groups all', { on: true, who: 'all', where: 'chat' }], ['groups private', { on: true, who: 'all', where: 'me' }], ['groups off', { on: false }], ['groups mine', { on: true, who: 'mine', where: 'chat' }]]) {
    assert.equal(await say(t, word), true);
    for (const [k, v] of Object.entries(want)) assert.equal(t.settings.groups[k], v, `${word}: ${k}`);
  }
  await t.updateSettings({ groups: { some: [CLUB] } });
  await say(t, 'groups');
  assert.match(t.out.at(-1).text, /Only in the groups you picked/);
  assert.match(t.out.at(-1).text, /\*groups all\*/);
});

test('the settings command sends the page\'s address, in the owner\'s language; the address alone signs nobody in', async () => {
  const t = tenant();
  assert.equal(await say(t, 'settings'), true);
  assert.match(t.out.at(-1).text, new RegExp(`https://ramble\\.example/settings/${t.id}$`));
  t.locale = 'he'; await say(t, 'settings');
  for (const line of t.out.at(-1).text.split('\n')) assert.match(line.match(/\p{L}/u)[0], /[֐-׿]/, line);
  assert.match(t.helpText(), /\*settings\*/);
  assert.ok(t.welcomeText().includes(`https://ramble.example/settings/${t.id}?welcome=1`), 'the welcome leads to the page'); assert.match(t.welcomeText(), /\*settings\*/);
  for (const line of t.welcomeText().split('\n').filter((l) => l.trim())) assert.match(line.match(/\p{L}/u)[0], /[֐-׿]/, line);
});

test('three digits in the control group open the browser waiting with them, and nothing else', async () => {
  const t = tenant();
  const a = D.openDoor(t, null, 'iPhone · Safari'), b = D.openDoor(t, null, 'Mac · Chrome');
  assert.match(a.code, /^[1-9]\d\d$/); assert.notEqual(a.code, b.code, 'two browsers waiting never share a code');
  assert.deepEqual(D.openDoor(t, a.id, 'iPhone · Safari'), a, 'a reload keeps its code');
  const other = ['100', '101', '102'].find((x) => x !== a.code && x !== b.code);
  assert.equal(await say(t, other), false, 'digits nobody waits with are an ordinary message'); assert.equal(t.sessions.length, 0);
  assert.equal(D.doorState(t, a.id).state, 'waiting');
  assert.equal(await say(t, a.code), true);
  assert.match(t.out.at(-1).text, /Settings opened on iPhone · Safari/);
  const open = D.doorState(t, a.id);
  assert.equal(open.state, 'open'); assert.equal(D.hasSession(t, open.token), true);
  assert.equal(D.doorState(t, a.id).state, 'gone', 'the session is handed over once');
  assert.equal(D.doorState(t, b.id).state, 'waiting', 'the other browser still waits');
  const theirs = { key: { remoteJid: CONTROL, fromMe: false, id: 'Q1', participant: RON }, message: { conversation: b.code } };
  assert.equal(await t.handleCommand(theirs, t.normalize(theirs), 'Ramble'), false, 'only the owner\'s own message counts');
  assert.equal(D.doorState(t, b.id).state, 'waiting');
  const later = Date.now() + D.CODE_TTL_MS + 1;
  assert.equal(D.answerDoor(t, b.code, later), null, 'a code lives ten minutes'); assert.equal(D.doorState(t, b.id, later).state, 'gone');
});

// ---------- the page ----------
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const HE = 'he-IL,he;q=0.9', EN = 'en-US,en;q=0.9';
function linked() {
  const t = registry.create({ start: false });
  t.linkedAt = Date.now();
  t.contactNames = new Map([[RON, 'Ron Levi'], [DANA, 'Dana'], [RON_LID, 'Ron Levi']]); t.altIds = new Map([[RON, RON_LID], [RON_LID, RON]]);
  t.savedNames = new Set([RON]); t.groupNames = new Map([[CLUB, 'Book club'], [CONTROL, 'Ramble']]); t.target = { jid: CONTROL, name: 'Ramble' };
  return { t, cookie: `rl=${t.id}.${D.startSession(t)}` };
}

test('a browser without a session gets a code, and the page once the owner sends it; an old link just loses its token', async () => {
  const { t } = linked();
  const old = await fetch(`${base}/settings/${t.id}?t=abc.def&w=1`, { redirect: 'manual' });
  assert.equal(old.status, 303); assert.equal(old.headers.get('location'), `/settings/${t.id}?welcome=1`); assert.equal(old.headers.get('set-cookie'), null);
  const door = await fetch(`${base}/settings/${t.id}?welcome=1`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1' } });
  assert.equal(door.status, 200);
  const html = await door.text(), code = /<div class="code">(\d{3})<\/div>/.exec(html)?.[1];
  assert.ok(code, 'it shows a code'); assert.match(html, /Send this code in your <b>Ramble<\/b> group/); assert.ok(html.includes(`href="https://wa.me/?text=${code}"`), 'a button into WhatsApp with the code typed in');
  assert.ok(!html.includes('chat.whatsapp.com'), 'never the group\'s invite link: anyone with the address sees this page');
  assert.ok(!/const S=/.test(html), 'and nothing of the settings');
  const rd = door.headers.get('set-cookie').split(';')[0]; assert.match(rd, /^rd=[0-9a-f]{20}$/);
  assert.equal((await fetch(`${base}/api/settings/${t.id}`, { headers: { cookie: rd } })).status, 404, 'waiting is not signed in');
  const again = await (await fetch(`${base}/settings/${t.id}`, { headers: { cookie: rd } })).text();
  assert.ok(again.includes(`<div class="code">${code}</div>`), 'a reload shows the same code');
  const wait = await fetch(`${base}/api/settings/${t.id}/door`, { headers: { cookie: rd } });
  assert.deepEqual(await wait.json(), { state: 'waiting' }); assert.equal(wait.headers.get('set-cookie'), null);
  t.out = []; t.sendPaced = async (jid, c) => { t.out.push({ jid, ...c }); return { key: { id: 'S' } }; };
  assert.equal(await say(t, code), true); assert.match(t.out.at(-1).text, /iPhone · Safari/);
  assert.ok(t.out.at(-1).text.endsWith(`https://ramble.example/settings/${t.id}`), 'and the link again, to go back by');
  const open = await fetch(`${base}/api/settings/${t.id}/door`, { headers: { cookie: rd } });
  assert.deepEqual(await open.json(), { state: 'open' });
  const rl = open.headers.get('set-cookie').split(', ').find((c) => c.startsWith('rl=')); assert.match(rl, /HttpOnly/);
  const page = await fetch(`${base}/settings/${t.id}?welcome=1`, { headers: { cookie: rl.split(';')[0] } });
  assert.equal(page.status, 200); assert.match(await page.text(), /const S=/, 'in');
  assert.deepEqual(await (await fetch(`${base}/api/settings/${t.id}/door`, { headers: { cookie: rd } })).json(), { state: 'gone' }, 'handed over once');
  const nobody = registry.create({ start: false });
  const n = await fetch(`${base}/settings/${nobody.id}`);
  assert.equal(n.status, 404, 'an account with no group to send a code in: no code'); assert.match(await n.text(), /Open this page from WhatsApp/);
  assert.equal((await fetch(`${base}/settings/nope`)).status, 404);
});

test('a browser whose page was paused while the code arrived is let in when it comes back by the link', async () => {
  const { t } = linked();
  const door = await fetch(`${base}/settings/${t.id}`);
  const code = /<div class="code">(\d{3})<\/div>/.exec(await door.text())[1], rd = door.headers.get('set-cookie').split(';')[0];
  t.sendPaced = async () => ({ key: { id: 'S' } });
  assert.equal(await say(t, code), true);
  const back = await fetch(`${base}/settings/${t.id}`, { headers: { cookie: rd } });
  assert.equal(back.status, 200); assert.match(await back.text(), /const S=/, 'the page itself, not a new code');
  const rl = back.headers.get('set-cookie').split(', ').find((c) => c.startsWith('rl='));
  assert.equal((await fetch(`${base}/api/settings/${t.id}`, { headers: { cookie: rl.split(';')[0] } })).status, 200, 'signed in from now on');
  assert.match(await (await fetch(`${base}/settings/${t.id}`, { headers: { cookie: rd } })).text(), /<div class="code">/, 'the handover happens once');
});

test('the page draws in both languages from the same strings; the welcome only right after linking', async () => {
  const { t, cookie } = linked();
  const get = async (q, al) => (await fetch(`${base}/settings/${t.id}${q}`, { headers: { cookie, 'accept-language': al } })).text();
  const table = (html) => JSON.parse(/const S=(\{.*?\});const P=/s.exec(html)[1]);
  const he = await get('', HE), en = await get('?welcome=1', EN);
  assert.match(he, /dir="rtl"/); assert.match(he, /no-store|Ramble/);
  const keys = (o) => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
  assert.deepEqual(keys(table(he)), keys(table(en)), 'a string added in one language must exist in the other');
  for (const [k, v] of Object.entries(table(he))) if (typeof v === 'string') assert.match(v, /[֐-׿]/, `${k} is Hebrew`);
  assert.ok(!/הקלטות/.test(JSON.stringify(table(he))), 'voice notes, never recordings');
  for (const S of [table(he), table(en)]) assert.ok(!/&#?\w+;/.test(JSON.stringify(S)), 'the script sets some of these as text: an HTML entity would show as written');
  assert.match(en, /id="toast"/); assert.ok(!/id="toast"/.test(he));
  assert.match(en, /id="cta"/, 'before the first voice note, the page leads into WhatsApp');
  t.firstNoteAt = Date.now();
  assert.ok(!/id="cta"/.test(await get('', EN)), 'after it, the settings stand alone');
  assert.ok(!/style="/.test(en), 'no inline styles: the CSP allows none');
});

test('the API: reads and saves the settings, refuses strangers and other sites, lists chats with names', async () => {
  const { t, cookie } = linked();
  const api = (path, opts = {}) => fetch(`${base}/api/settings/${t.id}${path}`, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
  const view = await (await api('')).json();
  assert.equal(view.where, 'chat'); assert.equal(view.groups.who, 'mine');
  const post = (body, headers = {}) => api('', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  const saved = await (await post({ where: 'me', chats: { some: [RON_LID, 'bogus'] } })).json();
  assert.equal(saved.where, 'me'); assert.deepEqual(saved.chats.some, [{ id: RON_LID, name: 'Ron Levi' }]);
  assert.equal(t.settings.chats.where, 'me');
  assert.equal((await post({ where: 'chat' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(t.settings.chats.where, 'me', 'nothing changed');
  assert.equal((await fetch(`${base}/api/settings/${t.id}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' })).status, 404, 'no session');
  const people = (await (await api('/chats?kind=chats')).json()).rows;
  assert.deepEqual(people.map((r) => r.slice(0, 2)), [[RON, 'Ron Levi'], [DANA, 'Dana']], 'one row per person, the phone id over the lid');
  const groups = (await (await api('/chats?kind=groups')).json()).rows;
  assert.deepEqual(groups.map((r) => r[1]), ['Book club'], 'never the control group');
});

test('the link page hands over to the settings page once linked', async () => {
  const { t, cookie } = linked();
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie } })).text();
  assert.match(html, new RegExp(`location\\.replace\\('/settings/${t.id}'`));
});

test('the button\'s group link exists only once joining needs approval; refused approval means no link', async () => {
  const calls = [];
  const t = tenant(); t.ready = true;
  t.sock = { groupJoinApprovalMode: async (jid, mode) => { calls.push(`approval ${mode}`); }, groupInviteCode: async () => { calls.push('invite'); return 'AbCdEf123'; } };
  const [a, b] = await Promise.all([t.groupLink(), t.groupLink()]);
  assert.equal(a, 'https://chat.whatsapp.com/AbCdEf123'); assert.equal(b, a);
  assert.deepEqual(calls, ['approval on', 'invite'], 'approval first, and once for two callers');
  assert.equal(await t.groupLink(), a); assert.equal(calls.length, 2, 'kept: WhatsApp is not asked again');
  assert.equal(t.settingsView().groupLink, a);
  const u = tenant(); u.ready = true; let invited = false;
  u.sock = { groupJoinApprovalMode: async () => { throw new Error('not allowed'); }, groupInviteCode: async () => { invited = true; return 'X'; } };
  assert.equal(await u.groupLink(), null); assert.equal(invited, false);
});

test('the new group is marked unread after the welcome, so it stands out though the welcome is the owner\'s own message', async () => {
  const t = tenant(); const mods = [];
  t.sock = { chatModify: async (mod, jid) => { mods.push([mod, jid]); } };
  t.markControlGroupUnread({ key: { id: 'W1', remoteJid: CONTROL, fromMe: true }, messageTimestamp: 1700000000 }, [10]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(mods, [[{ markRead: false, lastMessages: [{ key: { id: 'W1', remoteJid: CONTROL, fromMe: true }, messageTimestamp: 1700000000 }] }, CONTROL]]);
  t.markControlGroupUnread(null); t.markControlGroupUnread({ key: { id: 'W2' } }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(mods.length, 1, 'once, and never without a welcome');
  assert.ok(!mods.some(([mod]) => 'pin' in mod), 'never pinned: the pins are the owner\'s');
});

test('marking unread is tried again when WhatsApp is not ready for it yet', async () => {
  const t = tenant(); let tries = 0;
  t.sock = { chatModify: async () => { if (++tries < 2) throw new Error('myAppStateKey not present'); } };
  t.markControlGroupUnread({ key: { id: 'W3' }, messageTimestamp: 1 }, [10, 10]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tries, 2); assert.ok(t.target['marked unread']);
});

test('the language from the page: auto by default, a known one saved, anything else ignored', async () => {
  const { t, cookie } = linked();
  const html = await (await fetch(`${base}/settings/${t.id}`, { headers: { cookie, 'accept-language': HE } })).text();
  assert.match(html, /<option value="" selected>זיהוי אוטומטי \(מומלץ\)<\/option>/);
  const post = (body) => fetch(`${base}/api/settings/${t.id}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await post({ language: 'he' })).language, 'he'); assert.equal(t.language, 'he');
  assert.equal((await post({ language: 'klingon' })).language, 'he', 'not a language: unchanged');
  assert.equal((await post({ language: '' })).language, ''); assert.equal(t.language, '');
});

test('feedback from the page: kept with the account, at most ten a day, shown on the admin page and marked new once', async () => {
  const { t, cookie } = linked(); t.waName = 'Invented Owner';
  const send = (text) => fetch(`${base}/api/settings/${t.id}/feedback`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal((await send('  ')).status, 400);
  assert.equal((await send('The <b>toggle</b> is confusing.\nSecond line.')).status, 200);
  assert.equal(t.feedback.length, 1); assert.equal(t.feedback[0].text, 'The <b>toggle</b> is confusing.\nSecond line.');
  for (let i = 0; i < 9; i++) await send(`note ${i}`);
  assert.equal((await send('one too many')).status, 429); assert.equal(t.feedback.length, 10);
  const auth = { authorization: `Basic ${Buffer.from(':admin-secret-for-tests').toString('base64')}` };
  const admin = await (await fetch(`${base}/admin`, { headers: auth })).text();
  assert.match(admin, /Feedback <span class="danger">10 new<\/span>/);
  assert.match(admin, /The &lt;b&gt;toggle&lt;\/b&gt; is confusing\./, 'escaped, never markup');
  assert.match(admin, /Invented Owner/);
  assert.ok(!/new<\/span>/.test(await (await fetch(`${base}/admin`, { headers: auth })).text()), 'seen once the page was opened');
  assert.equal((await fetch(`${base}/api/settings/${t.id}/feedback`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{"text":"x"}' })).status, 404, 'no session');
  await registry.remove(t.id);
  assert.ok(!/Invented Owner/.test(await (await fetch(`${base}/admin`, { headers: auth })).text()), 'erased with the account');
});

test('the page keeps its parts in order: where, what, the language, then feedback and unlink side by side', async () => {
  const { t, cookie } = linked();
  const html = await (await fetch(`${base}/settings/${t.id}`, { headers: { cookie } })).text();
  const at = (s) => html.indexOf(s);
  assert.ok(at('class="box where"') < at('id="secs"') && at('id="secs"') < at('id="lang"') && at('id="lang"') < at('class="acts"'));
  assert.match(html, /<div class="acts"><button type="button" class="act" data-act="fb">/);
  assert.match(html, new RegExp(`action="/unlink/${t.id}"`));
});

test('the group picker: the most recently active first, archived and muted ones marked so the page leaves them out until a search', async () => {
  const t = tenant();
  t.sock = { groupFetchAllParticipating: async () => ({ '1001@g.us': { subject: 'Old', participants: [1, 2] }, '1002@g.us': { subject: 'Busy', participants: [1] }, '1003@g.us': { subject: 'Archived' }, '1004@g.us': { subject: 'Muted' }, [CONTROL]: { subject: 'Ramble' } }) };
  t.onChats([{ id: '1001@g.us', conversationTimestamp: 1000 }, { id: '1003@g.us', conversationTimestamp: 5000, archived: true }, { id: '1004@g.us', conversationTimestamp: 6000, muteEndTime: -1 }]);
  await t.onMessage({ key: { remoteJid: '1002@g.us', id: 'X1', participant: '1@s.whatsapp.net' }, messageTimestamp: 9000, message: { conversation: 'hi' } }, t.sock);
  const rows = await t.settingsDirectory('groups');
  assert.deepEqual(rows.map((r) => [r[1], r[4]]), [['Busy', 0], ['Muted', 1], ['Archived', 1], ['Old', 0]]);
  t.onChats([{ id: '1004@g.us', muteEndTime: null }]);
  assert.equal((await t.settingsDirectory('groups')).find((r) => r[1] === 'Muted')[4], 0, 'unmuted');
  assert.ok(!JSON.stringify([...t.chatActivity]).includes('hi'), 'times only, never what was said');
});

test('the people picker: the most recently talked-to first, archived and muted ones marked, one row per person', async () => {
  const t = tenant();
  t.contactNames = new Map([[RON, 'Ron Levi'], [RON_LID, 'Ron Levi'], [DANA, 'Dana'], ['446@s.whatsapp.net', 'Quiet Person'], ['447@s.whatsapp.net', 'Old Friend']]);
  t.altIds = new Map([[RON, RON_LID], [RON_LID, RON]]); t.savedNames = new Set([DANA]);
  t.onChats([{ id: DANA, conversationTimestamp: 100 }, { id: '446@s.whatsapp.net', conversationTimestamp: 900, muteEndTime: -1 }]);
  await t.onMessage({ key: { remoteJid: RON_LID, id: 'X9' }, messageTimestamp: 500, message: { conversation: 'x' } }, t.sock);
  const rows = await t.settingsDirectory('chats');
  assert.deepEqual(rows.map((r) => [r[1], r[4]]), [['Quiet Person', 1], ['Ron Levi', 0], ['Dana', 0], ['Old Friend', 0]], 'activity under the lid counts for the person');
  assert.equal(rows.find((r) => r[1] === 'Ron Levi')[0], RON, 'the phone id over the lid');
});

test('a person written to under their lid is one row, under the name the owner saved, with that activity', async () => {
  const t = tenant(); const LID = '77777@lid', PN = '972500000777@s.whatsapp.net';
  t.contactNames = new Map([[PN, 'Eden Saved'], [LID, '+972 •••••• 77']]); t.savedNames = new Set([PN]);
  t.sock = { signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === LID ? '972500000777:3@s.whatsapp.net' : null) } } };
  await t.onMessage({ key: { remoteJid: LID, fromMe: true, id: 'L1' }, messageTimestamp: 900, message: { conversation: 'x' } }, t.sock);
  const rows = await t.settingsDirectory('chats');
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[3]]), [[PN, 'Eden Saved', 900000]]);
});

test('a community\'s own entry is never offered as a group; the groups inside it are', async () => {
  const t = tenant();
  t.sock = { groupFetchAllParticipating: async () => ({ '2001@g.us': { subject: 'Neighbours', isCommunity: true }, '2002@g.us': { subject: 'Neighbours chat', linkedParent: '2001@g.us' } }) };
  t.onChats([{ id: '2001@g.us', conversationTimestamp: 999 }]);
  assert.deepEqual((await t.settingsDirectory('groups')).map((r) => r[1]), ['Neighbours chat']);
});

test('only others\': other people\'s voice notes are transcribed and mine are not, in the chat or to me; the Ramble group still always is', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { chats: { who: 'others' }, groups: { who: 'others' } }) });
  assert.deepEqual(await matrix(t), [`theirs@${RON}>chat`, `theirs@${CLUB}>chat`]);
  await t.updateSettings({ where: 'me' });
  assert.deepEqual(await matrix(t), [`theirs@${RON}>me`, `theirs@${CLUB}>me`]);
  assert.equal(t.route({ chatId: CONTROL, fromMe: true, isGroup: true }), 'chat', 'a voice note recorded in the Ramble group');
  assert.equal(t.groups, 'others-private'); assert.equal(S.legacyGroups(t.settings), 'private');
  await t.updateSettings({ where: 'chat' }); assert.equal(S.legacyGroups(t.settings), 'off', 'a server from before posts nothing it wasn\'t asked to');
  assert.equal(await say(t, 'groups mine'), true); assert.equal(await say(t, 'groups others'), true); assert.equal(t.settings.groups.who, 'others');
  assert.match(t.out.at(-1).text, /other people's voice notes get their text/);
});

test('the admin page sees how the settings page is used and what each account chose, never which chats', async () => {
  const { t, cookie } = linked();
  await fetch(`${base}/settings/${t.id}`, { headers: { cookie } }); await fetch(`${base}/settings/${t.id}`, { headers: { cookie } });
  await fetch(`${base}/api/settings/${t.id}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ where: 'me', chats: { some: [RON] } }) });
  const s = t.status({ history: true });
  assert.equal(s.settingsUse.visits, 2); assert.equal(s.settingsUse.changes, 1); assert.ok(s.settingsUse.firstAt && s.settingsUse.lastChangeAt);
  assert.deepEqual(s.settings.chats, { on: true, who: 'all', where: 'me', picked: 1 });
  assert.ok(!JSON.stringify(s.settings).includes(RON.split('@')[0]), 'counts, not ids');
  assert.equal(new Tenant(JSON.parse(readFileSync(join(t.dir, 'tenant.json'), 'utf8')), t.dir).settingsUse.visits, 2, 'kept with the account');
});
