// node --test test/commands.test.mjs — the owner's recent commands, for the admin page: the command
// word, what came of it, and whether the reply went out. Never a name or any text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-commands-'));
const { Tenant } = await import('../src/tenant.js');

const CONTROL = '999@g.us';
function tenant({ realSend = false } = {}) {
  const id = `cm${Math.random()}`.replace('.', '');
  const t = new Tenant({ id, createdAt: Date.now() }, join(process.env.DATA_DIR, id));
  t.target = { jid: CONTROL, name: 'Ramble' };
  t.contactNames = new Map([['444@s.whatsapp.net', 'Ron Levi']]); // invented
  let seq = 0;
  t.sock = { sendMessage: async () => ({ key: { id: `S${++seq}` } }), groupFetchAllParticipating: async () => ({}), signalRepository: { lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null } } };
  if (!realSend) t.sendPaced = async () => ({ key: { id: `S${++seq}` } });
  return t;
}
const say = (t, body) => { const key = { remoteJid: CONTROL, fromMe: true, id: `T${Math.random()}` }; const message = { conversation: body }; return t.handleCommand({ key, message }, t.normalize({ key, message }), 'Ramble'); };

test('each command and its outcome is noted, failures included, with no names or text', async () => {
  const t = tenant();
  await say(t, 'exclude Ron'); await say(t, 'yes');
  await say(t, 'private Somebody Unknown');
  await say(t, 'yes');
  await say(t, 'see you at eight');
  await say(t, 'groups off');
  assert.deepEqual(t.commands.map((c) => [c.cmd, c.outcome]), [
    ['exclude', 'asked to confirm (a private chat)'], ['exclude', 'done (a private chat)'],
    ['private', 'no chat with that name'],
    ['reply', 'nothing was waiting for it (expired or already answered)'],
    ['text', 'not a command'],
    ['groups', 'set to off'],
  ]);
  const disk = readFileSync(join(t.dir, 'commands.json'), 'utf8');
  for (const word of ['Ron', 'Somebody', 'eight']) assert.ok(!disk.includes(word), `${word} must not be stored`);
  assert.equal(t.status({ history: true }).commands[0].cmd, 'groups', 'the admin status has them, newest first');
  assert.equal(t.status().commands, undefined, 'the owner-facing status does not');
});

test('whether the reply went out is noted on the command it answers', async () => {
  const t = tenant({ realSend: true });
  await say(t, 'help');
  assert.equal(t.commands.at(-1).replied, true);
  t.sock.sendMessage = async () => { throw new Error('not connected'); };
  await say(t, 'language');
  assert.equal(t.commands.at(-1).replied, false);
  assert.equal(t.commands.at(-2).replied, true, 'an earlier command keeps its own answer');
});
