// node --test test/ab-signals.test.mjs — what people do with a recording's text is counted
// against its arm (reaction, deletion, reply, a new recording soon after), with the seconds since
// the text went out, and never with a word of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-signals-'));
process.env.AB_SHARE_B = '0.5'; process.env.AB_SHARE_C = '0';
const { Tenant } = await import('../src/tenant.js');

const CHAT = '111@s.whatsapp.net';
function account() {
  const t = new Tenant({ id: 'sig', createdAt: Date.now() }, join(process.env.DATA_DIR, 'sig'));
  t.sock = {}; t.lines = [];
  const orig = console.log; t.restore = () => { console.log = orig; };
  console.log = (...a) => { const s = a.join(' '); if (s.includes('🧪')) t.lines.push(s); else orig(...a); };
  return t;
}
const records = () => readdirSync(join(process.env.DATA_DIR, 'experiments')).flatMap((f) => readFileSync(join(process.env.DATA_DIR, 'experiments', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));

test('reaction, deletion, reply and a quick re-recording are counted against the arm, with the gap, without content', async () => {
  const t = account();
  try {
    // A recording in arm B got its text 20 s ago, posted as our message P1.
    const at = Date.now() - 20e3;
    t.abRecs.set('R1', { arm: 'B', at, chatId: CHAT, sender: CHAT });
    t.abPosts.set('P1', { recId: 'R1', arm: 'B', at, chatId: CHAT, sender: CHAT });
    t.abLastPost.set(`${CHAT}|${CHAT}`, { arm: 'B', at, recId: 'R1' });
    const msg = (message, id) => ({ key: { remoteJid: CHAT, fromMe: false, id }, message });
    await t.onMessage(msg({ reactionMessage: { key: { id: 'P1' }, text: '👎' } }, 'M1'), t.sock);
    await t.onMessage(msg({ protocolMessage: { type: 0, key: { id: 'P1' } } }, 'M2'), t.sock);
    await t.onMessage(msg({ extendedTextMessage: { text: 'מה זה אמור להיות', contextInfo: { stanzaId: 'P1' } } }, 'M3'), t.sock);
    const voice = msg({ audioMessage: { ptt: true, seconds: 3, fileSha256: Buffer.from('x'), mimetype: 'audio/ogg' } }, 'M4');
    t.handleRecording = async () => {}; // the new recording itself is not transcribed here
    await t.onMessage(voice, t.sock);
    const kinds = t.lines.map((l) => l.match(/🧪 (\w+) arm=(\w) on=(\w+) gap=([\d.]+)s/)).filter(Boolean).map((m) => m.slice(1));
    assert.deepEqual(kinds.map((k) => k[0]), ['react', 'revoke', 'reply', 'rerecord']);
    assert.ok(kinds.every((k) => k[1] === 'B'));
    assert.ok(kinds.every((k) => Number(k[3]) >= 19 && Number(k[3]) <= 22), `gaps ${kinds.map((k) => k[3])}`);
    assert.ok(records().filter((r) => r.kind !== 'recording').every((r) => Number.isFinite(r.gap) && r.gap >= 19.5 && r.gap <= 21.5), 'the exact gap, in seconds, is in every record');
    assert.ok(t.lines.every((l) => !l.includes('מה זה')), 'the reply text is not logged');
    const recs = records();
    assert.equal(recs.filter((r) => r.kind === 'rerecord').length, 1);
    assert.ok(recs.every((r) => !JSON.stringify(r).includes('מה זה')));
    assert.equal(recs.find((r) => r.kind === 'react').emoji, '👎');
  } finally { t.restore(); }
});

test('a recording more than a minute after our text is not a re-recording; unknown ids are ignored', async () => {
  const t = account();
  try {
    t.abLastPost.set(`${CHAT}|${CHAT}`, { arm: 'B', at: Date.now() - 61e3, recId: 'R9' });
    t.handleRecording = async () => {};
    await t.onMessage({ key: { remoteJid: CHAT, fromMe: false, id: 'M5' }, message: { audioMessage: { ptt: true, seconds: 3, fileSha256: Buffer.from('y'), mimetype: 'audio/ogg' } } }, t.sock);
    await t.onMessage({ key: { remoteJid: CHAT, fromMe: false, id: 'M6' }, message: { reactionMessage: { key: { id: 'nobody' }, text: '👍' } } }, t.sock);
    assert.deepEqual(t.lines, []);
  } finally { t.restore(); }
});
