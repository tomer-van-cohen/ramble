// node --test test/web.test.mjs — HTTP-level checks against the real app (no WhatsApp socket).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-web-'));
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.PUBLIC_URL = 'https://ramble.example'; // settings links need a site address
process.env.ANNOUNCE_GAP_MS = '0';
process.env.STARTS_PER_HOUR = '12'; // every sign-up test shares one address; the limit test loops until it is refused
process.env.TRUST_PROXY = '0';
const registry = await import('../src/registry.js');
const { startSession } = await import('../src/door.js');
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const t = registry.create({ language: 'he', start: false });
t.target = { jid: '1@g.us', name: '<img src=x onerror="document.body.dataset.x=1">' }; // hostile control-group name
t.mode = 'connected'; t.ready = true;

test('security headers on every response; private pages are no-store', async () => {
  const r = await fetch(`${base}/`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-/); assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  const p = await fetch(`${base}/link/${t.id}`, { redirect: 'manual' });
  assert.equal(p.headers.get('cache-control'), 'no-store');
});

const ADMIN = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: base };
const supportKey = async (a) => new URL((await (await fetch(`${base}/admin/link/${a.id}`, { method: 'POST', headers: ADMIN })).json()).link).searchParams.get('k');

test('a support link signs every browser out, and becomes a session of its own for a day', async () => {
  const before = `rl=${t.id}.${startSession(t)}`;
  assert.equal((await fetch(`${base}/link/${t.id}`, { headers: { cookie: before } })).status, 200);
  const k = await supportKey(t);
  assert.equal((await fetch(`${base}/link/${t.id}`, { headers: { cookie: before } })).status, 404, 'every earlier browser is signed out');
  const r = await fetch(`${base}/link/${t.id}?k=${k}`, { redirect: 'manual' });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/link/${t.id}`);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^rl=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  assert.ok(!cookie.includes(k), 'the cookie holds its own session, not the link');
  const page = await fetch(`${base}/link/${t.id}`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(page.status, 200);
  const api = await fetch(`${base}/api/link/${t.id}`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(api.status, 200);
  assert.equal((await fetch(`${base}/link/${t.id}`)).status, 404, 'no cookie → not found');
  assert.equal((await fetch(`${base}/link/${t.id}?k=${k}`, { redirect: 'manual' })).status, 303, 'good for the day, more than once');
  t.entry.exp = Date.now() - 1;
  assert.equal((await fetch(`${base}/link/${t.id}?k=${k}`, { redirect: 'manual' })).status, 404, 'not after');
  const old = `rl=${t.id}.${'k'.repeat(32)}`;
  assert.equal((await fetch(`${base}/link/${t.id}`, { headers: { cookie: old } })).status, 404, 'a cookie that is not one of its sessions (as the old key cookies are) opens nothing');
});

test('a hostile control-group name is escaped, never executed', async () => {
  const cookie = `rl=${t.id}.${startSession(t)}`;
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie } })).text();
  assert.ok(!html.includes('<img src=x onerror'), 'raw name must not appear in the HTML');
  const json = await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json();
  assert.equal(json.controlGroup, t.target.name, 'the API returns it as data; the page escapes it in JS');
  assert.match(html, /const esc=s=>/, 'page script escapes dynamic values');
});

test('wrong, malformed and multi-byte keys and cookies are rejected cleanly (404, never 500)', async () => {
  for (const c of ['rl=x', `rl=${t.id}.`, `rl=${t.id}.${encodeURIComponent('ה'.repeat(32))}`, `rl=other.${startSession(t)}`, 'rl=%E0%A4%A']) assert.equal((await fetch(`${base}/link/${t.id}`, { headers: { cookie: c } })).status, 404, c);
  for (const k of ['nope', 'ה'.repeat(32), 'z'.repeat(32), '', '%00', 'A'.repeat(31)]) {
    const r = await fetch(`${base}/link/${t.id}?k=${encodeURIComponent(k)}`, { redirect: 'manual' });
    assert.equal(r.status, 404, `key ${JSON.stringify(k)}`);
  }
  assert.equal((await fetch(`${base}/link/../etc/passwd?k=${'0'.repeat(32)}`)).status, 404);
});

test('cross-site POSTs are refused, same-site ones pass', async () => {
  const cookie = `rl=${t.id}.${startSession(t)}`;
  const cross = await fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'phone=15550100001', redirect: 'manual' });
  assert.equal(cross.status, 403);
  const fetchSite = await fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' }, body: 'phone=15550100001', redirect: 'manual' });
  assert.equal(fetchSite.status, 403);
  const same = await fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'phone=15550100001', redirect: 'manual' });
  assert.equal(same.status, 303); assert.equal(t.pairPhone, '15550100001');
  // A browser that withholds the origin sends "Origin: null": our own form still goes through, a foreign one does not.
  const post = (h) => fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, origin: 'null', 'content-type': 'application/x-www-form-urlencoded', ...h }, body: 'phone=15550100002', redirect: 'manual' });
  assert.equal((await post({ 'sec-fetch-site': 'same-origin' })).status, 303); assert.equal(t.pairPhone, '15550100002'); t.usePairingQr();
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({})).status, 403, 'a null origin with nothing to vouch for it is refused');
  const adminCross = await fetch(`${base}/admin/link/${t.id}`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: 'https://evil.example' } });
  assert.equal(adminCross.status, 403);
});

test('admin: one card per account shows who it is (WhatsApp name, number); names are escaped', async () => {
  t.phone = '15550100009'; t.waName = '<img src=x onerror=alert(1)>Dana'; t.linkedAt = Date.now();
  const list = await (await fetch(`${base}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  assert.match(list, new RegExp(`href="/admin/a/${t.id}"`)); assert.ok(list.includes('&lt;img src=x onerror=alert(1)&gt;Dana') && !list.includes('<img src=x onerror'));
  const html = await (await fetch(`${base}/admin/a/${t.id}`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  assert.match(html, new RegExp(`id="a-${t.id}"`));
  assert.match(html, /href="https:\/\/wa\.me\/15550100009"/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;Dana') && !html.includes('<img src=x onerror'));
  assert.ok(!html.includes('<table'), 'no wide table to scroll sideways');
  assert.match(html, /<b>0<\/b> recordings<br><span class="muted">0 theirs · 0 from others/);
  assert.ok(!/ style="/.test(html), 'no inline style attributes: the CSP would drop them');
  const j = await (await fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).json();
  assert.equal(j.tenants.find((x) => x.id === t.id).phone, '15550100009');
  assert.ok(!('phone' in t.status()), 'the owner-facing status contract is unchanged');
  t.phone = ''; t.waName = ''; t.linkedAt = 0;
});

test('admin shows the server\'s vital signs: files and space on the volume, refused writes, sign-ups turned away', async () => {
  const health = await import('../src/health.js');
  // 5 GB volume, every file slot taken, most of the space free: the state that stops a server while "disk" looks fine.
  const full = health.diskUsage({ blocks: 1200000, bfree: 850000, bavail: 800000, bsize: 4096, files: 305824, ffree: 0 });
  assert.equal(full.filesPct, 100); assert.equal(full.filesFree, 0); assert.equal(full.spacePct, 29);
  assert.equal(health.diskUsage(null), null);
  health._reset();
  assert.equal(health.noteError(Object.assign(new Error('ENOSPC: no space left on device, open \'/x/y.json\''), { code: 'ENOSPC' })), true);
  assert.equal(health.noteError(new Error('EDQUOT: quota exceeded')), true);
  assert.equal(health.noteError(new Error('some other failure')), false);
  health.noteTurnedAway('full'); health.noteTurnedAway('rate'); health.noteTurnedAway('rate'); health.noteTurnedAway(undefined);
  const auth = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') };
  const j = await (await fetch(`${base}/admin.json`, { headers: auth })).json();
  assert.equal(j.health.diskFailures.failures, 2); assert.equal(j.health.diskFailures.lastCode, 'EDQUOT');
  assert.deepEqual([j.health.turnedAway.full, j.health.turnedAway.waiting, j.health.turnedAway.rate], [1, 0, 2]);
  assert.ok(j.health.memoryMb > 0); assert.ok(j.maxPending > 0);
  const html = await (await fetch(`${base}/admin`, { headers: auth })).text();
  for (const label of ['Files on disk', 'Disk space', 'Failed writes', 'Turned away', 'Memory']) assert.ok(html.includes(label), label);
  assert.match(html, /Failed writes<\/small><b><span class="danger">2<\/span>/);
  assert.match(html, /1 full · 0 queue · 0 load · 2 rate limit/);
  health._reset();
});

test('after the process stood still, sign-ups pause until a quiet minute; the queue page is what the visitor sees', async () => {
  const health = await import('../src/health.js');
  assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: true });
  health._stalled(health.STALL_PAUSE_MS + 500); // the loop just stood still for longer than the threshold
  try {
    assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: false });
    const res = await fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'accept-language': 'en' }, body: 'consent=1', redirect: 'manual' });
    assert.equal(res.status, 503); assert.ok((await res.text()).includes('there is a queue'));
    const j = await (await fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).json();
    assert.equal(j.health.admission.open, false); assert.equal(j.health.admission.why, 'stall'); assert.equal(j.health.turnedAway.stall, 1);
  } finally { health._reset(); }
  assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: true });
});

test('before a deploy the door closes, and the server says when no one is halfway through linking', async () => {
  const registry = await import('../src/registry.js');
  const auth = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: base };
  const drain = async (on) => (await fetch(`${base}/admin/drain${on == null ? '' : `?on=${on}`}`, { method: on == null ? 'GET' : 'POST', headers: auth })).json();
  const before = await drain(); assert.equal(before.draining, false); // other tests' accounts may count too: compare with this
  // Someone is looking at a QR code; someone else linked a minute ago.
  const viewer = registry.create({ start: false });
  await fetch(`${base}/api/link/${viewer.id}`, { headers: { cookie: `rl=${viewer.id}.${startSession(viewer)}` } });
  const fresh = registry.create({ start: false }); fresh.linkedAt = Date.now() - 60e3;
  try {
    let s = await drain(1);
    assert.deepEqual([s.draining, s.viewing - before.viewing, s.justLinked - before.justLinked, s.ready], [true, 1, 1, false]);
    assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: false }, 'no new sign-ups while draining');
    const res = await fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'accept-language': 'en' }, body: 'consent=1', redirect: 'manual' });
    assert.equal(res.status, 503); assert.ok((await res.text()).includes('there is a queue'), 'the visitor gets the queue page, which carries on by itself');
    viewer.lastViewedAt = Date.now() - 60e3; fresh.linkedAt = Date.now() - 10 * 60e3; // the QR page closed; the link is past its first minutes
    s = await drain(); assert.deepEqual([s.viewing, s.justLinked], [before.viewing, before.justLinked], 'these two no longer hold it back');
    assert.equal(s.ready, before.viewing === 0 && before.justLinked === 0, 'safe to restart once no one else is in the middle either');
    const j = await (await fetch(`${base}/admin.json`, { headers: auth })).json();
    assert.equal(j.health.admission.why, 'deploy'); assert.equal(j.health.turnedAway.deploy, 1);
  } finally { await drain(0); await registry.remove(viewer.id); await registry.remove(fresh.id); }
  assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: true }, 'open again');
});

test('at capacity the visitor is told we are full and to come back tomorrow, not left waiting on a queue page', async () => {
  const registry = await import('../src/registry.js');
  const filler = []; while (registry.list().length < registry.MAX_TENANTS) { const t = registry.create({ start: false }); t.linkedAt = Date.now() - 864e5; filler.push(t); }
  try {
    for (const [lang, want] of [['en', 'full right now'], ['he', 'אנחנו מלאים כרגע']]) {
      const res = await fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'accept-language': lang }, body: 'consent=1', redirect: 'manual' });
      assert.equal(res.status, 503); const html = await res.text();
      assert.ok(html.includes(want), lang); assert.ok(!html.includes("fetch('/api/room'"), 'no self-retrying queue page');
    }
  } finally { for (const t of filler) await registry.remove(t.id); }
});

test('opening the link page wakes an account that went to sleep without a pairing', async () => {
  const registry = await import('../src/registry.js');
  const t2 = registry.create({ start: false }); t2.linkedAt = Date.now() - 864e5;
  let woke = 0; t2.link = { wake: () => { woke++; return true; }, stop: async () => ({ loggedOut: false }) };
  try {
    const r = await fetch(`${base}/api/link/${t2.id}`, { headers: { cookie: `rl=${t2.id}.${startSession(t2)}` } });
    assert.equal(r.status, 200); assert.equal(woke, 1);
    assert.equal((await fetch(`${base}/api/link/${t2.id}`)).status, 404); assert.equal(woke, 1, 'no key, no wake');
  } finally { await registry.remove(t2.id); }
});

test('notes: a dry run counts the audience by language, a test goes to one account, a send goes once per account, values filled in', async () => {
  const registry = await import('../src/registry.js');
  const auth = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: base, 'content-type': 'application/json' };
  const post = async (body) => (await fetch(`${base}/admin/announce`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json();
  const mk = (locale) => { const a = registry.create({ start: false, locale }); a.linkedAt = Date.parse('2026-10-01T10:00:00Z'); a.ready = true; a.waName = 'Dana Levi'; a.target = { jid: `${a.id.slice(0, 8)}@g.us` }; a.sent = []; a.sock = { chatModify: async () => {} }; a.sendPaced = async (jid, m) => { a.sent.push(m); return { key: { id: 'M' + a.sent.length }, messageTimestamp: 1 }; }; return a; };
  const he = mk('he'), en = mk('en'), offline = mk('he'); offline.ready = false;
  const late = mk('en'); late.linkedAt = Date.now();
  const note = { name: 'settings-page', he: 'היי {name}, יש עמוד הגדרות: {link} {unknown}', en: 'Hi {name}, there is a settings page: {link}', audience: { linkedBefore: '2026-10-06T20:14:00Z' } };
  try {
    assert.ok((await post({ ...note, name: 'Bad Name' })).error.startsWith('name'));
    assert.ok((await post({ ...note, image: Buffer.from('not a picture').toString('base64') })).error.startsWith('image'));
    const dry = await post(note);
    assert.equal(dry.dryRun, true); assert.ok(dry.he >= 1 && dry.en >= 1 && dry.offline >= 1);
    assert.equal(he.sent.length + en.sent.length, 0, 'a dry run sends nothing');
    assert.equal((await post({ ...note, audience: { ...note.audience, lang: 'en' } })).he, 0, 'audience by language');
    assert.equal((await post({ ...note, to: he.id })).result, 'sent (he)');
    const t0 = he.sent[0].text;
    assert.ok(t0.startsWith('היי Dana, יש עמוד הגדרות: ') && !t0.includes('{link}') && t0.endsWith('{unknown}'), 'known values filled in, unknown ones left alone');
    assert.ok(!he.target.announced, 'a test is not recorded');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await post({ ...note, to: en.id, image: jpeg.toString('base64') });
    assert.ok(Buffer.isBuffer(en.sent[0].image) && en.sent[0].caption.startsWith('Hi Dana'), 'a picture goes with the text as its caption');
    const go = await post({ ...note, go: true }); assert.ok(go.total >= 2);
    for (let i = 0; i < 50 && !(await (await fetch(`${base}/admin/announce`, { headers: auth })).json()).done; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(he.sent.length, 2, 'the test, then the real one'); assert.equal(en.sent.length, 2); assert.equal(late.sent.length, 0); assert.equal(offline.sent.length, 0);
    assert.deepEqual(he.target.announced, ['settings-page']);
    assert.equal(await he.sendNote('settings-page', note), 'already sent');
    const adminHtml = await (await fetch(`${base}/admin`, { headers: auth })).text();
    assert.ok(adminHtml.includes('Note to accounts') && adminHtml.includes('settings-page'), 'the admin page shows the send');
  } finally { for (const a of [he, en, offline, late]) { a.link = { stop: async () => ({ loggedOut: false }) }; await registry.remove(a.id); } }
});

test('notes: "active" and "at least" come from the usage kept on disk, so a restart does not shrink the audience', async () => {
  const registry = await import('../src/registry.js');
  const auth = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: base, 'content-type': 'application/json' };
  const post = async (body) => (await fetch(`${base}/admin/announce`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json();
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  // lastMessageAt 0: as right after a restart, before anything arrived.
  const mk = (history, seconds) => { const a = registry.create({ start: false, locale: 'en' }); a.linkedAt = Date.now() - 30 * 864e5; a.ready = true; a.lastMessageAt = 0; a.target = { jid: `${a.id.slice(0, 8)}@g.us` }; a.usageHistory = history; a.totals = { own: 2, others: 0, ownSeconds: seconds }; return a; };
  const week = mk([{ day: day(2), minutes: 4 }], 240), old = mk([{ day: day(12), minutes: 9 }], 540), brief = mk([{ day: day(1), minutes: 0 }], 20);
  const ids = [week.id, old.id, brief.id], note = { name: 'weekly-test', he: 'x', en: 'x' };
  try {
    const dry = await post({ ...note, audience: { ids, activeDays: 7 } });
    assert.equal(dry.eligible, 2, 'audio this week counts, though no message came since the restart');
    assert.equal(dry.audience.ids, 3, 'the reply counts the ids instead of repeating them');
    assert.equal((await post({ ...note, audience: { ids, activeDays: 7, atLeast: { week_minutes: 1 } } })).eligible, 1, 'no one is told about zero minutes');
    assert.equal((await post({ ...note, audience: { ids, atLeast: { total_minutes: 4 } } })).eligible, 2);
    assert.ok((await post({ ...note, audience: { ids, atLeast: { link: 1 } } })).error.startsWith('atLeast'));
  } finally { for (const a of [week, old, brief]) { a.link = { stop: async () => ({ loggedOut: false }) }; await registry.remove(a.id); } }
});

test('the control groups\' description: a test sets one, a send sets the rest in each owner\'s language once, and new groups take the latest', async () => {
  const registry = await import('../src/registry.js'); const { Tenant } = await import('../src/tenant.js');
  const auth = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: base, 'content-type': 'application/json' };
  const post = async (body) => (await fetch(`${base}/admin/announce`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json();
  const mk = (locale) => { const a = registry.create({ start: false, locale }); a.linkedAt = Date.now() - 864e5; a.ready = true; a.target = { jid: `${a.id.slice(0, 8)}@g.us` }; a.desc = []; a.sock = { groupUpdateDescription: async (jid, d) => { a.desc.push(d); } }; return a; };
  const he = mk('he'), en = mk('en');
  const d = { description: true, he: 'לינק לשיתוף: https://ramble.example\nלהגדרות כתבו "settings"', en: 'Link to share: https://ramble.example\nFor settings, write "settings"' };
  assert.ok(Tenant.controlDescription().he.includes('ramble.baby'), 'a default before anything is set');
  try {
    assert.equal((await post({ ...d, to: he.id })).result, 'set'); assert.deepEqual(he.desc, [d.he]);
    const go = await post({ ...d, go: true }); assert.ok(go.total >= 1, 'the test account already has it');
    for (let i = 0; i < 50 && !(await (await fetch(`${base}/admin/announce`, { headers: auth })).json()).done; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(en.desc, [d.en]); assert.equal(he.desc.length, 1, 'already that: not set again');
    assert.deepEqual(Tenant.controlDescription(), { he: d.he, en: d.en }, 'kept for groups made from now on');
  } finally { for (const a of [he, en]) { a.link = { stop: async () => ({ loggedOut: false }) }; await registry.remove(a.id); } }
});

test('a shared link shows a picture, a title and a text: share tags on every page, and the picture and icons are real files', async () => {
  for (const lang of ['en', 'he']) {
    const html = await (await fetch(`${base}/`, { headers: { 'accept-language': lang, 'user-agent': 'facebookexternalhit/1.1' } })).text();
    for (const tag of ['og:image', 'og:title', 'og:description', 'og:url', 'og:image:width', 'twitter:card']) assert.ok(html.includes(`property="${tag}"`) || html.includes(`name="${tag}"`), `${tag} (${lang})`);
    assert.match(html, /property="og:image" content="https:\/\/[^"]+\/og\.png"/, 'an absolute picture address');
  }
  for (const path of ['/og.png', '/icon-180.png', '/favicon-32.png', '/favicon.ico', '/apple-touch-icon.png']) {
    const r = await fetch(`${base}${path}`); assert.equal(r.status, 200, path); assert.equal(r.headers.get('content-type'), 'image/png');
    const b = Buffer.from(await r.arrayBuffer()); assert.equal(b.subarray(1, 4).toString(), 'PNG', path);
  }
  const og = Buffer.from(await (await fetch(`${base}/og.png`)).arrayBuffer());
  assert.equal(og.readUInt32BE(16), 1200); assert.equal(og.readUInt32BE(20), 630); assert.ok(og.length < 300_000, 'WhatsApp shows pictures under 300 KB');
});

test('a sign-up records where it came from (country, device, source, returning browser); admin shows it in one line', async () => {
  const first = await fetch(`${base}/`);
  const rv = /rv=([0-9a-f]{20})/.exec(first.headers.get('set-cookie') || '')?.[1];
  assert.ok(rv, 'a public page gives the browser an anonymous id');
  const again = await fetch(`${base}/how`, { headers: { cookie: `rv=${rv}` } });
  assert.ok(!/rv=/.test(again.headers.get('set-cookie') || ''), 'a known browser keeps its id');
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const r = await fetch(`${base}/start`, { method: 'POST', redirect: 'manual', headers: { origin: base, cookie: `rv=${rv}`, 'user-agent': ua, 'accept-language': 'he-IL,he;q=0.9', 'content-type': 'application/x-www-form-urlencoded' }, body: 'consent=1&tz=Asia%2FJerusalem&from=https%3A%2F%2Fwww.example.com%2Fsome%2Fpath%3Fq%3D1' });
  const made = registry.get(r.headers.get('location').split('/').pop());
  const u = registry.signupOf(made);
  assert.equal(u.device, 'iPhone · Safari'); assert.deepEqual(u.country, { code: 'IL', how: 'browser language' });
  assert.equal(u.tz, 'Asia/Jerusalem'); assert.equal(u.from, 'example.com', 'the host only, never the path or query');
  assert.equal(u.visitor, rv); assert.equal(u.visits, 2); assert.ok(u.ip);
  const html = await (await fetch(`${base}/admin/a/${made.id}`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  const card = html.slice(html.indexOf(`id="a-${made.id}"`), html.indexOf('</article>', html.indexOf(`id="a-${made.id}"`)));
  assert.match(card, /Waiting to link/); assert.match(card, /removed in \d+ min/);
  assert.match(card, /Israel/); assert.match(card, /iPhone · Safari/); assert.match(card, /from example\.com/); assert.match(card, /returning browser: 1 earlier visit/);
  assert.ok(!card.includes('Minutes transcribed'), 'no empty stats for an account that never linked');
  await registry.remove(made.id);
});

test('funnel: one person per browser, crawlers and the operator left out; came → clicked → linked', async () => {
  const admin = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') };
  const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
  const funnelOf = async () => { const h = await (await fetch(`${base}/admin?days=1`, { headers: admin })).text(); return [...h.matchAll(/<div class="fhead"><b>(\d+)<\/b>/g)].map((m) => Number(m[1])); };
  const before = await funnelOf();
  // A crawler and a link preview get no id and count as nobody.
  for (const bot of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'WhatsApp/2.23.20.0 A']) assert.ok(!/rv=/.test((await fetch(`${base}/`, { headers: { 'user-agent': bot } })).headers.get('set-cookie') || ''));
  // A person: lands from a referring site, the page's script reports back, visits twice, signs up twice, links once.
  const land = await fetch(`${base}/`, { headers: { 'user-agent': ua, referer: 'https://news.example.org/post/1' } });
  const rv = /rv=([0-9a-f]{20})/.exec(land.headers.get('set-cookie'))[1];
  const h = { 'user-agent': ua, cookie: `rv=${rv}`, origin: base };
  assert.equal((await fetch(`${base}/hi`, { method: 'POST', headers: h })).status, 204);
  await fetch(`${base}/`, { headers: h });
  // Two sign-ups from this browser, as /start records them (the HTTP path is covered above; its per-address limit is shared by these tests).
  const visitors = await import('../src/visitors.js');
  const signUp = () => { const x = registry.create({ signup: { visitor: rv, device: 'Android · Chrome' }, start: false }); visitors.addAccount(rv, x.id); return x; };
  const a = signUp(), b = signUp();
  let html = await (await fetch(`${base}/admin`, { headers: admin })).text();
  assert.match(html, /Waiting to link <span class="muted">×2<\/span>/, 'two waiting sign-ups from one browser are one row');
  assert.match(await (await fetch(`${base}/admin/a/${a.id}`, { headers: admin })).text(), /×2 sign-ups, same browser/);
  assert.deepEqual(await funnelOf(), [before[0] + 1, before[1] + 1, before[2]], 'one person came and clicked, twice over');
  b.linkedAt = Date.now(); b.onFirstLink(b);
  assert.deepEqual(await funnelOf(), [before[0] + 1, before[1] + 1, before[2] + 1]);
  html = await (await fetch(`${base}/admin?days=1`, { headers: admin })).text();
  assert.match(html, /<span>news\.example\.org<\/span><span>1<\/span><span>1<\/span><span>1<\/span><span>100%<\/span>/);
  assert.match(html, /<span>Android<\/span>/);
  // The operator's own browser opening /admin leaves the funnel.
  await fetch(`${base}/admin`, { headers: { ...admin, cookie: `rv=${rv}` } });
  assert.deepEqual(await funnelOf(), before);
  await registry.remove(a.id); await registry.remove(b.id);
});

test('admin: wrong passwords are rate limited; healthz says only ok', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') } })).status, 401);
  assert.equal((await fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).status, 429, 'locked out even with the right password');
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
});

test('sign-up remembers whether to talk Hebrew or English', async () => {
  const start = (al) => fetch(`${base}/start`, { method: 'POST', headers: { origin: base, 'accept-language': al, 'content-type': 'application/x-www-form-urlencoded' }, body: 'consent=1', redirect: 'manual' });
  for (const [al, want] of [['he-IL,he;q=0.9,en;q=0.8', 'he'], ['fr-FR,fr;q=0.9', 'en']]) {
    const r = await start(al);
    assert.equal(r.status, 303);
    const made = registry.get(r.headers.get('location').split('/').pop());
    assert.equal(made.locale, want);
    await registry.remove(made.id);
  }
});

test('when sign-ups are paused the visitor gets a friendly page that retries on its own; /api/room says when there is room', async () => {
  const registry = await import('../src/registry.js');
  assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: true });
  // Fill the queue of unscanned sign-ups (no sockets: start:false), then arrive as one more.
  const filler = []; while (registry.pendingCount() < registry.MAX_PENDING) filler.push(registry.create({ start: false }));
  try {
    assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: false });
    const res = await fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'accept-language': 'en' }, body: 'consent=1&ref=abcd1234&tz=Asia%2FJerusalem', redirect: 'manual' });
    assert.equal(res.status, 503);
    const html = await res.text();
    assert.ok(html.includes('there is a queue') && html.includes('carries on by itself'), 'friendly wording');
    assert.ok(html.includes('action="/start"') && html.includes('name="consent" value="1"') && html.includes('name="ref" value="abcd1234"'), 'the same sign-up is resent');
    assert.ok(html.includes("fetch('/api/room'") && html.includes('f.submit()'), 'retries by itself');
    assert.ok(!html.includes('down') && !html.includes('error'), 'no "server down" language');
    const he = await (await fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'accept-language': 'he' }, body: 'consent=1', redirect: 'manual' })).text();
    assert.ok(he.includes('יש תור'));
  } finally { for (const t of filler) await registry.remove(t.id); }
  assert.deepEqual(await (await fetch(`${base}/api/room`)).json(), { room: true });
});

test('sign-up: consent required, per-IP limit, pending cap', async () => {
  const post = (body) => fetch(`${base}/start`, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  // Earlier tests in this file also sign up from this address, so the limit may already be near.
  const first = await post('language=he');
  if (first.status === 303) assert.equal(first.headers.get('location'), '/', 'no consent → back to landing'); else assert.equal(first.status, 429);
  let r; for (let i = 0; i < 14; i++) r = await post('language=zz');
  assert.equal(r.status, 429, 'too many attempts in an hour are refused');
});

// ---- retest findings R6, R7 ----
test('R6: the link page script runs after the DOM exists (script at the end of body, inside DOMContentLoaded)', async () => {
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie: `rl=${t.id}.${startSession(t)}` } })).text();
  const script = html.indexOf('<script'); const unlink = html.indexOf('id="unlink"'); const bodyEnd = html.indexOf('</body>');
  assert.ok(script > unlink && script < bodyEnd, 'script must come after the #unlink form');
  assert.match(html.slice(script), /DOMContentLoaded/);
  // Sanity: the script body parses (a syntax error would leave the page stuck on "Starting…").
  const src = html.slice(script).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  new Function(src); // throws on a syntax error
});

test('R7: a malformed cookie is treated as no cookie (404), never a 500', async () => {
  for (const cookie of ['rl=%', 'rl=%E0%A4%A', 'rl', '=x', `rl=${t.id}.%ZZ`]) {
    const r = await fetch(`${base}/link/${t.id}`, { headers: { cookie } });
    assert.equal(r.status, 404, `cookie ${JSON.stringify(cookie)}`);
  }
});

test('fonts are served from this origin (the CSP allows no other), and only the known files', async () => {
  const r = await fetch(`${base}/fonts/geist.woff2`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'font/woff2');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.match(r.headers.get('content-security-policy'), /font-src 'self'/);
  assert.equal((await fetch(`${base}/fonts/..%2Fweb.js`)).status, 404);
});

test('the how-it-works page is public and linked from the landing page', async () => {
  const how = await fetch(`${base}/how`);
  assert.equal(how.status, 200); assert.match(await how.text(), /How it works\./);
  assert.match(await (await fetch(`${base}/`)).text(), /href="\/how"/);
});

test('the link page has no URL to keep and no invite; leaving is pointed at WhatsApp', async () => {
  const token = startSession(t);
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie: `rl=${t.id}.${token}` } })).text();
  assert.ok(!html.includes(token), 'the session is never printed');
  assert.ok(!/Keep this page|Invite a friend/.test(html));
  assert.match(html, /write <b>leave<\/b>/);
});

test('link page: a phone defaults to a code, a desktop to the QR, and ?via= overrides', async () => {
  const cookie = `rl=${t.id}.${startSession(t)}`;
  const get = async (ua, q = '') => (await fetch(`${base}/link/${t.id}${q}`, { headers: { cookie, 'user-agent': ua } })).text();
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
  assert.match(await get(iphone), /let via='code'/); assert.match(await get(mac), /let via='qr'/);
  assert.match(await get(iphone, '?via=qr'), /let via='qr'/); assert.match(await get(mac, '?via=code'), /let via='code'/);
  assert.match(await get(mac, '?via=<script>'), /let via='qr'/, 'anything else is the default');
});

test('link with a code: the number is kept with the account; a bad one is refused; the QR can be chosen again', async () => {
  const cookie = `rl=${t.id}.${startSession(t)}`;
  const post = (path, body) => fetch(`${base}/link/${t.id}/${path}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  assert.equal((await post('code', 'phone=abc')).status, 400); assert.equal(t.pairPhone, '');
  const ok = await post('code', 'phone=%2B972%2050-123%204567');
  assert.equal(ok.status, 303); assert.equal(t.pairPhone, '972501234567');
  const api = await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json();
  assert.equal(api.pairByCode, true); assert.equal(api.pairingCode, null, 'no socket waiting for a scan yet: no code');
  assert.ok(!JSON.stringify(api).includes('972501234567'), 'the number itself is not echoed');
  const back = await post('qr', '');
  assert.equal(back.status, 303); assert.equal(back.headers.get('location'), `/link/${t.id}?via=qr`); assert.equal(t.pairPhone, '');
});

test('linked: one call to action into WhatsApp, the tools folded away, nothing left to do on the page', async () => {
  const cookie = `rl=${t.id}.${startSession(t)}`;
  t.ownId = '15550100000@s.whatsapp.net';
  const api = await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json();
  assert.equal(api.waMe, 'https://wa.me/15550100000');
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie } })).text();
  assert.match(html, /id="fx"/); assert.match(html, /Open WhatsApp/); assert.match(html, /Record a voice note there/); assert.match(html, /const openWa="https:\/\/web\.whatsapp\.com\/"/, 'a computer opens WhatsApp Web');
  assert.ok(!/Keep this page|Then send someone|Leave it on auto|id="lang"/.test(html), 'no language selector: that is set from WhatsApp');
  t.ownId = null;
  assert.equal((await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json()).waMe, null);
});

