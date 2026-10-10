// node --test test/hebrew.test.mjs — the site in Hebrew for a browser whose first language is Hebrew.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-he-'));
process.env.TRUST_PROXY = '0';
process.env.GITHUB_STARS = 'off';
const registry = await import('../src/registry.js');
const { startSession } = await import('../src/door.js');
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const HE = 'he-IL,he;q=0.9,en;q=0.8', EN = 'en-US,en;q=0.9', EN_HE = 'en-US,en;q=0.9,he;q=0.8';
const get = async (path, al, cookie = '') => { const r = await fetch(`${base}${path}`, { headers: { 'accept-language': al, ...(cookie ? { cookie } : {}) }, redirect: 'manual' }); return { r, html: await r.text() }; };

test('Hebrew only for a browser whose first language is Hebrew; English otherwise', async () => {
  for (const path of ['/', '/how', '/privacy']) {
    const he = await get(path, HE);
    assert.match(he.html, /<html lang="he" dir="rtl">/, path); assert.match(he.html, /[֐-׿]{4}/);
    for (const al of [EN, EN_HE, 'el-GR', '']) assert.match((await get(path, al)).html, /<html lang="en" dir="ltr">/, `${path} ${al}`);
  }
  assert.match((await get('/', 'iw')).html, /dir="rtl"/, 'the old code for Hebrew counts');
  assert.match((await get('/', HE)).r.headers.get('vary'), /Accept-Language/);
});

test('an English page offers Hebrew only to a browser that has it; a Hebrew page always offers English', async () => {
  assert.match((await get('/', EN_HE)).html, /href="\?lang=he"/);
  assert.ok(!(await get('/', EN)).html.includes('lang=he'));
  assert.match((await get('/', HE)).html, /href="\?lang=en"/);
});

test('?lang= switches, is remembered, and the page comes back without the query', async () => {
  const { r } = await get('/how?lang=he', EN);
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/how');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal(cookie, 'lang=he');
  assert.match((await get('/how', EN, cookie)).html, /dir="rtl"/);
  assert.match((await get('/how', HE, 'lang=en')).html, /dir="ltr"/, 'the choice wins over the browser');
  assert.match((await get('/', EN, 'lang=xx')).html, /dir="ltr"/, 'an unknown value is ignored');
});

test('the Hebrew landing page keeps everything the form needs', async () => {
  const { html } = await get('/', HE);
  for (const must of ['id="start"', 'name="consent" value="1"', 'name="tz"', 'class="cta"', 'href="/privacy"', 'class="safe"']) assert.ok(html.includes(must), must);
  assert.match(html, /פטפטו חופשי/); assert.match(html, /אין דאגות/);
});

test('the link page draws every state in Hebrew, with the same strings as in English', async () => {
  const t = registry.create({ start: false });
  const cookie = `rl=${t.id}.${startSession(t)}`;
  const table = (html) => JSON.parse(/const S=(\{.*?\});const fill/s.exec(html)[1]);
  const he = table((await get(`/link/${t.id}`, HE, cookie)).html), en = table((await get(`/link/${t.id}`, EN, cookie)).html);
  assert.deepEqual(Object.keys(he).sort(), Object.keys(en).sort(), 'a string added in one language must exist in the other');
  for (const [k, v] of Object.entries(he)) assert.match(v, /[֐-׿]/, `${k} is Hebrew`);
  for (const k of ['manual', 'orLeave']) assert.ok(he[k].includes('{p}') && en[k].includes('{p}'), k);
  assert.ok(he.waiting.includes('{g}') && he.codeFor.includes('{n}'));
  await registry.remove(t.id);
});

test('the small pages speak the page language too', async () => {
  const nf = await get('/link/nope', HE);
  assert.equal(nf.r.status, 404); assert.match(nf.html, /הקישור הזה לא תקף/);
  assert.match((await get('/link/nope', EN)).html, /This link is not valid/);
});

test('signing up from a Hebrew site starts the account in Hebrew', async () => {
  const r = await fetch(`${base}/start`, { method: 'POST', headers: { origin: base, 'accept-language': EN, cookie: 'lang=he', 'content-type': 'application/x-www-form-urlencoded' }, body: 'consent=1', redirect: 'manual' });
  assert.equal(r.status, 303);
  const t = registry.get(r.headers.get('location').split('/').pop());
  assert.equal(t.locale, 'he');
  await registry.remove(t.id);
});
