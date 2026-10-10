// node --test test/video.test.mjs — videos are transcribed only for an account an admin turned them on for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-video-'));
process.env.CLAIM_YIELD_MS = '5';
delete process.env.TRANSCRIBE_VIDEO;
const { Tenant } = await import('../src/tenant.js');

const FRIEND = '444@s.whatsapp.net';
let seq = 0;
function tenant(rec = {}) {
  const id = `v${++seq}`;
  const t = new Tenant({ id, createdAt: Date.now(), ...rec }, join(process.env.DATA_DIR, id));
  t.target = { jid: '999@g.us', name: 'Ramble' };
  t.worked = [];
  t.sendPaced = async () => ({ key: { id: `S${++seq}` } });
  t.handleRecording = async (m, n, chatName, isVideo) => { t.worked.push(isVideo ? 'video' : 'voice'); return true; };
  t.sock = {};
  return t;
}
const media = { mediaKey: 'AAAA', directPath: '/v/t62.7161-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7161-24/abc.enc', fileLength: 1200, seconds: 30 };
const send = (t, kind) => { const id = `M${++seq}`; const message = kind === 'video' ? { videoMessage: { ...media, mimetype: 'video/mp4', fileSha256: Buffer.from(id) } } : { audioMessage: { ...media, ptt: true, mimetype: 'audio/ogg', fileSha256: Buffer.from(id) } }; return t.onMessage({ key: { remoteJid: FRIEND, fromMe: false, id }, messageTimestamp: Math.floor(Date.now() / 1000), message }, t.sock); };

test('a new account: voice notes yes, videos no', async () => {
  const t = tenant();
  await send(t, 'voice'); await send(t, 'video');
  assert.deepEqual(t.worked, ['voice']);
});

test('turned on by an admin: videos too, and it is kept with the account', async () => {
  const t = tenant();
  t.setTranscribeVideo(true);
  await send(t, 'video');
  assert.deepEqual(t.worked, ['video']);
  assert.equal(JSON.parse(readFileSync(join(t.dir, 'tenant.json'), 'utf8')).transcribeVideo, true);
  assert.equal(t.status().transcribeVideo, true);
  const again = tenant({ transcribeVideo: true }); await send(again, 'video');
  assert.deepEqual(again.worked, ['video'], 'read back from the record');
  t.setTranscribeVideo(false); t.worked.length = 0; await send(t, 'video');
  assert.deepEqual(t.worked, []);
});
