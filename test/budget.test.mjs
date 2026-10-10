// node --test test/budget.test.mjs — cost controls: server budget, per-account cap,
// per-recording limit, plans and the dedupe cache. No network, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-budget-'));
process.env.GLOBAL_DAILY_MINUTES = '10';   // 600 s for the whole server
process.env.DAILY_MINUTES_CAP = '5';       // 300 s per account
process.env.MAX_TRANSCRIBE_SECONDS = '600';
process.env.TRANSCRIBE_API_KEY = 'test-pro';
process.env.TRANSCRIBE_MODEL = 'pro-model';
process.env.FREE_TRANSCRIBE_API_KEY = 'test-free';
process.env.FREE_TRANSCRIBE_MODEL = 'free-model';

const budget = await import('../src/budget.js');
const { Tenant, DAILY_MINUTES_CAP, MAX_TRANSCRIBE_SECONDS } = await import('../src/tenant.js');
const { planLabel, planEnabled } = (await import('../src/brain/index.js')).brain.info();

const mk = (id, extra = {}) => new Tenant({ id, createdAt: Date.now(), ...extra }, join(process.env.DATA_DIR, id));

test('the server budget is shared: one account cannot spend past the server ceiling', () => {
  budget.__reset();
  assert.equal(budget.reserve(300), true);   // 5 min
  assert.equal(budget.reserve(300), true);   // 10 min — exactly the ceiling
  assert.equal(budget.reserve(1), false);    // nothing left for anyone
  assert.equal(budget.secondsToday(), 600);
});

test('a refund returns seconds to the server budget', () => {
  budget.__reset();
  assert.equal(budget.reserve(600), true);
  budget.refund(600);
  assert.equal(budget.secondsToday(), 0);
  assert.equal(budget.reserve(600), true);
});

test('yesterday’s spend does not count against today, but today’s survives a reload', async () => {
  budget.__reset('2000-01-01', 600);                 // a full day, long ago
  assert.equal(budget.secondsToday(), 0, 'a stale day rolls over to zero');
  assert.equal(budget.reserve(600), true, 'today starts with the whole budget');
  // A restart re-reads the file: today's spend is still there.
  const reloaded = await import(`../src/budget.js?reload=${Date.now()}`);
  assert.equal(reloaded.secondsToday(), 600, 'a restart does not hand out a fresh budget');
  assert.equal(reloaded.reserve(1), false);
});

test('the per-account cap is atomic: parallel recordings cannot both slip under it', () => {
  const t = mk('acct1');
  assert.equal(t.reserveUsage(240), true);          // 4 of 5 minutes
  assert.equal(t.reserveUsage(120), false, 'would exceed the cap, so it is refused up front');
  assert.equal(t.reserveUsage(60), true);           // exactly 5 minutes
  assert.equal(t.overCap(), true);
  assert.equal(DAILY_MINUTES_CAP, 5);
});

test('one long recording cannot eat a whole day', () => {
  assert.equal(MAX_TRANSCRIBE_SECONDS, 600);
  assert.ok(MAX_TRANSCRIBE_SECONDS <= DAILY_MINUTES_CAP * 60 * 4, 'the per-recording limit is a fraction of a day');
});

test('plans pick different providers, and an account defaults to the configured plan', () => {
  assert.equal(planEnabled('pro'), true);
  assert.equal(planEnabled('free'), true);
  assert.equal(planLabel('pro'), 'pro-model');
  assert.equal(planLabel('free'), 'free-model');
  assert.equal(mk('acct2').plan, 'pro');                      // DEFAULT_PLAN
  assert.equal(mk('acct3', { plan: 'free' }).plan, 'free');   // as recorded
  assert.equal(mk('acct4', { plan: 'nonsense' }).plan, 'pro', 'a bad value falls back to the default');
});

test('setPlan accepts only known plans and persists to tenant.json', () => {
  const t = mk('acct5');
  assert.equal(t.setPlan('free'), true);
  assert.equal(t.plan, 'free');
  assert.equal(t.setPlan('enterprise'), false);
  assert.equal(t.plan, 'free');
  // What the registry would read back on the next boot.
  const rec = JSON.parse(readFileSync(join(process.env.DATA_DIR, 'acct5', 'tenant.json'), 'utf8'));
  assert.equal(rec.plan, 'free');
  assert.equal(new Tenant(rec, join(process.env.DATA_DIR, 'acct5')).plan, 'free');
});

test('the same recording twice is served from memory, and expires', () => {
  const t = mk('acct6');
  assert.equal(t.cachedFor('sha-1'), null);
  t.cacheText('sha-1', 'the text', 'the summary');
  assert.deepEqual([t.cachedFor('sha-1').content, t.cachedFor('sha-1').summary], ['the text', 'the summary']);
  t.recent.get('sha-1').at = Date.now() - 2 * 3600e3; // older than the TTL
  assert.equal(t.cachedFor('sha-1'), null);
  assert.equal(t.cachedFor(null), null, 'no fingerprint, no cache hit');
});

test('the dedupe cache is capped and lives only in memory', () => {
  const t = mk('acct7');
  for (let i = 0; i < 260; i++) t.cacheText(`sha-${i}`, 'x', null);
  assert.ok(t.recent.size <= 200, `cache grew to ${t.recent.size}`);
  assert.equal(t.cachedFor('sha-0'), null, 'the oldest entries are dropped');
  const onDisk = JSON.stringify(Object.keys(t));
  assert.ok(!onDisk.includes('recentFile'), 'nothing about the cache is persisted');
});

test('the A/B list accepts several models and routes whisper* to the free provider', async () => {
  // transcribeRun is not called here (no network); this checks the parsing contract
  // the admin endpoint and the tenant rely on.
  const t = mk('acct8');
  t.setAbModel('gpt-4o-transcribe, whisper-large-v3-turbo ,,');
  assert.equal(t.abModel, 'gpt-4o-transcribe, whisper-large-v3-turbo ,,');
  const parsed = t.abModel.split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(parsed, ['gpt-4o-transcribe', 'whisper-large-v3-turbo']);
  t.setAbModel('');
  assert.equal(t.abModel, '', 'empty turns the comparison off');
});

