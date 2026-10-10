// node --test test/brain.test.mjs — the contract between the shell and the brain, on the
// plain brain: what goes out (a buffer, a model, a language), what comes back, what it
// never touches. Fake network, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checkBrain } from '../src/brain/contract.js';
import { createBrain } from '../src/brain/plain.js';

const fakeNet = (answer = 'שלום, מה קורה') => {
  const calls = [];
  return {
    calls,
    transcribeAudio: async (host, audio, opts) => { calls.push({ host, audio, opts }); return answer; },
    chatCompletion: async () => { throw new Error('the plain brain never chats'); },
    hosts: { pro: { enabled: true, label: 'api.openai.com', groq: false, openai: true }, free: { enabled: false, label: 'api.groq.com', groq: true, openai: false } },
  };
};

test('the plain brain satisfies the contract and says what it is', () => {
  const b = checkBrain(createBrain({ net: fakeNet(), env: { TRANSCRIBE_MODEL: 'gpt-transcribe' } }), 'plain');
  const i = b.info();
  assert.equal(i.enabled, true); assert.deepEqual(i.plans, ['free', 'pro']);
  assert.equal(i.planLabel('pro'), 'gpt-transcribe'); assert.equal(i.planLabel('free'), 'not configured');
  assert.equal(i.correction, null); assert.equal(i.summary, null); assert.equal(i.dictation, false); assert.equal(i.experiment, null);
  assert.match(i.startupLines()[0], /plain brain/);
});

test('process(): the audio buffer, the model and the language go out; the text comes back untouched', async () => {
  const net = fakeNet('  היי, מה המצב?  ');
  const b = createBrain({ net, env: { TRANSCRIBE_MODEL: 'gpt-transcribe' } });
  const buf = Buffer.from('OggS fake');
  const stages = [];
  const out = await b.process({ audio: { buf, name: 'note.ogg' }, seconds: 3, isVideo: false, plan: 'pro', language: 'he', speaker: 'Dana', isMe: false, names: 'Eden', fingerprint: 'abc', compareModels: null, shadow: false, onStage: (s) => stages.push(s) });
  assert.equal(net.calls.length, 1);
  const c = net.calls[0];
  assert.equal(c.host, 'pro'); assert.equal(c.audio.buf, buf); assert.equal(c.audio.name, 'note.ogg');
  assert.deepEqual({ model: c.opts.model, language: c.opts.language }, { model: 'gpt-transcribe', language: 'he' });
  // Nothing about the speaker, the names or the account reaches the provider from the plain brain.
  assert.ok(!JSON.stringify(c.opts).includes('Dana') && !JSON.stringify(c.opts).includes('Eden'));
  assert.equal(out.text, '  היי, מה המצב?  '); assert.equal(out.raw, out.text); assert.equal(out.summary, null); assert.equal(out.dropped, null);
  assert.equal(out.fix.reason, 'skipped'); assert.equal(out.arm, 'A'); assert.deepEqual(out.compare, []); assert.equal(out.later, null);
  assert.deepEqual(stages, ['transcribed', 'corrected']);
});

test('process(): a plan without a host falls to the one that has; an empty answer is dropped, not delivered', async () => {
  const net = fakeNet('');
  const b = createBrain({ net, env: {} });
  const out = await b.process({ audio: { buf: Buffer.alloc(1), name: 'a.ogg' }, seconds: 5, plan: 'free' });
  assert.equal(net.calls[0].host, 'pro'); assert.equal(out.usedFallback, true);
  assert.equal(out.text, null); assert.equal(out.dropped, 'empty');
  assert.equal(await b.dictation('send Eden that I am on my way'), null);
});

test('checkBrain refuses a brain without the surface', () => {
  assert.throws(() => checkBrain({ info: () => ({}), process: async () => {} }, 'x'), /missing dictation/);
  assert.throws(() => checkBrain({ info: () => ({ enabled: true }), process: async () => {}, dictation: async () => null }, 'x'), /info\(\) lacks/);
});

// What no brain may do, by the only means Node offers: the file system and the network, by
// any import, dynamic import, require or global; and nothing of the shell's that would hand
// it a path or a host. The plain brain is scanned always; the private one whenever it is
// checked out beside src/ — so the same rule holds for the brain that actually runs.
const FORBIDDEN = [
  [/\bfrom\s+['"](node:)?(fs|fs\/promises|child_process|net|http|https|http2|dgram|tls|worker_threads|cluster|os|v8|vm)['"]/, 'imports a system module'],
  [/\bimport\s*\(/, 'imports at run time'],
  [/\brequire\s*\(/, 'requires'],
  [/\bprocess\.(binding|dlopen|_linkedBinding)\b/, 'reaches into the runtime'],
  [/\b(eval|Function)\s*\(/, 'evaluates code'],
  [/\b(fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(|\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b/, 'opens a connection'],
  [/\bglobalThis\b|\bglobal\[/, 'reaches for a global by name'],
  [/paths\.js|providers\.js|research\.js|media\.js|\bDATA_DIR\b/, 'names the shell\'s files or data'],
];
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
function brainModules() {
  const out = [];
  for (const dir of ['src/brain', ...(existsSync('brain') ? ['brain'] : [])]) {
    // Modules only: brain/test and brain/scripts are not loaded by the shell. src/brain/index.js is the
    // loader, the shell's side of the line (it reads the disk to find the brain), not a brain.
    for (const f of readdirSync(dir)) if (f.endsWith('.js') && !(dir === 'src/brain' && f === 'index.js')) out.push(join(dir, f));
  }
  return out;
}

test('no brain can touch the file system or the network: the plain one, and the private one when it is checked out', () => {
  const files = brainModules();
  assert.ok(files.includes(join('src/brain', 'plain.js')));
  for (const f of files) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const [re, what] of FORBIDDEN) {
      const m = code.match(re);
      assert.ok(!m, `${f} ${what}: ${m?.[0]}`);
    }
  }
  if (existsSync('brain')) assert.ok(files.some((f) => f.startsWith('brain/')), 'the private brain was scanned too');
});

// The loader runs at import with top-level await; each case is its own process.
const load = (env, brainDir) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  const { brain, brainSource } = await import(${JSON.stringify(new URL('../src/brain/index.js', import.meta.url).href)});
  console.log(JSON.stringify({ source: brainSource, pro: brain.info().planLabel('pro') }));
`], { env: { ...process.env, TRANSCRIBE_API_KEY: 'k', TRANSCRIBE_MODEL: 'm-pro', REQUIRE_BRAIN: '', BRAIN: '', BRAIN_DIR: brainDir, ...env }, encoding: 'utf8' });

test('the loader takes the private brain from BRAIN_DIR when it is there, else the plain one; REQUIRE_BRAIN refuses the plain one; BRAIN=plain forces it', () => {
  const none = mkdtempSync(join(tmpdir(), 'ramble-nobrain-'));
  let r = load({}, none);
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { source: 'plain', pro: 'm-pro' });
  r = load({ REQUIRE_BRAIN: '1' }, none);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /REQUIRE_BRAIN=1 but no brain/);
  const dir = mkdtempSync(join(tmpdir(), 'ramble-brain-')); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), `export function createBrain({ net }) { return { info: () => ({ enabled: true, plans: ['pro'], planEnabled: () => true, planLabel: () => 'private-' + (net.hosts.pro ? 'ok' : 'no'), correction: 'x', summary: null, dictation: false, experiment: null, prices: {}, startupLines: () => [] }), process: async () => ({}), dictation: async () => null }; }`);
  r = load({}, dir);
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { source: 'private', pro: 'private-ok' });
  r = load({ BRAIN: 'plain' }, dir);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).source, 'plain');
});
