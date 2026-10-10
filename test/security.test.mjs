// node --test test/security.test.mjs — pure checks for the hardening (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mediaDownloadPolicy, MAX_MEDIA_BYTES } from '../src/media.js';
import { createSemaphore } from '../src/semaphore.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-sec-'));
const { Tenant, DAILY_MINUTES_CAP } = await import('../src/tenant.js');
const tenant = () => new Tenant({ id: 'sec', createdAt: Date.now() }, join(process.env.DATA_DIR, 'sec'));
const okNode = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30 };

test('media policy: only WhatsApp CDN over https, with a direct path and a size cap', () => {
  assert.equal(mediaDownloadPolicy(okNode).ok, true);
  assert.equal(mediaDownloadPolicy({ ...okNode, url: 'https://media-tlv1-1.cdn.whatsapp.net/o1/v/x.enc' }).host, 'media-tlv1-1.cdn.whatsapp.net');
  for (const [node, reason] of [
    [{ ...okNode, url: 'http://mmg.whatsapp.net/v/x.enc' }, 'not https'],
    [{ ...okNode, url: 'https://127.0.0.1/v/x.enc' }, 'host not allowed'],
    [{ ...okNode, url: 'https://169.254.169.254/latest/meta-data' }, 'host not allowed'],
    [{ ...okNode, url: 'https://[::1]/v/x.enc' }, 'host not allowed'],
    [{ ...okNode, url: 'https://mmg.whatsapp.net.evil.example/v/x.enc' }, 'host not allowed'],
    [{ ...okNode, url: 'https://evilwhatsapp.net/v/x.enc' }, 'host not allowed'],
    [{ ...okNode, url: 'https://mmg.whatsapp.net:8443/v/x.enc' }, 'host not allowed'],
    [{ ...okNode, directPath: undefined }, 'no direct path'],
    [{ ...okNode, directPath: '//evil.example/x' }, 'no direct path'],
    [{ ...okNode, mediaKey: undefined }, 'no media key'],
    [{ ...okNode, fileLength: MAX_MEDIA_BYTES + 1 }, 'too large'],
    [{ ...okNode, fileLength: -5 }, 'bad length'],
  ]) { const r = mediaDownloadPolicy(node); assert.equal(r.ok, false, JSON.stringify(node)); assert.equal(r.reason, reason); }
});

test('view-once media is never processed; ephemeral media is, and carries its timer', () => {
  const t = tenant();
  const key = { remoteJid: '972500000000@s.whatsapp.net', fromMe: false, id: 'M1' };
  const audio = { ...okNode, ptt: true, mimetype: 'audio/ogg', contextInfo: { expiration: 604800 } };
  assert.equal(t.normalize({ key, message: { viewOnceMessage: { message: { audioMessage: audio } } } }), null);
  assert.equal(t.normalize({ key, message: { viewOnceMessageV2: { message: { audioMessage: audio } } } }), null);
  assert.equal(t.normalize({ key, message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: { audioMessage: audio } } } } } }), null);
  const n = t.normalize({ key, message: { ephemeralMessage: { message: { audioMessage: audio } } } });
  assert.equal(n.isVoice, true); assert.equal(n.expiration, 604800); assert.equal(n.mediaNode, audio);
});

test('recording length from the message is validated: negative, NaN and absurd values cannot move the quota', () => {
  const t = tenant();
  const key = { remoteJid: '972500000000@s.whatsapp.net', fromMe: false, id: 'M2' };
  const mk = (seconds) => t.normalize({ key, message: { audioMessage: { ...okNode, ptt: true, seconds } } }).seconds;
  assert.equal(mk(-600), 0); assert.equal(mk('abc'), 0); assert.equal(mk(Infinity), 0); assert.equal(mk(99999999), 4 * 3600); assert.equal(mk(42), 42);
});

test('quota is reserved before any work, so parallel recordings cannot all slip under the cap', () => {
  const t = tenant();
  process.env.TZ = 'UTC';
  t.addUsage(50); t.addUsage(50); // two "parallel" 50s notes under a 60s cap: the second must already see 100s reserved
  assert.equal(t.usageSecondsToday(), 100);
});

test('semaphore bounds concurrency and preserves order', async () => {
  const sem = createSemaphore(2);
  let running = 0, peak = 0; const order = [];
  await Promise.all([1, 2, 3, 4, 5].map((i) => sem.run(async () => { running++; peak = Math.max(peak, running); order.push(i); await new Promise((r) => setTimeout(r, 5)); running--; })));
  assert.equal(peak, 2); assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('log hygiene: no source line logs transcript text, summaries, chat names or people\'s names', () => {
  const forbidden = [/console\.(log|warn|error)\([^\n]*\$\{(text|content|summary|out|raw|r\.text|body|chatName|name|src\.name|t\.target\.name)(\.slice\([^)]*\))?\}/];
  // The shell, and the private brain when it is checked out beside it: it must not log a word either.
  const dirs = ['src', 'src/brain', ...(existsSync('brain') ? ['brain'] : [])];
  for (const dir of dirs) for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) { // src/fonts is a folder of binaries
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => { for (const re of forbidden) assert.ok(!re.test(line), `${dir}/${f}:${i + 1} logs content: ${line.trim()}`); });
  }
});

// ---- retest findings R1–R4 ----
import { Readable } from 'node:stream';
import { readBounded } from '../src/media.js';

test('R1: a message carrying two media objects is refused before anything is validated or downloaded', () => {
  const t = tenant();
  const key = { remoteJid: '972500000000@s.whatsapp.net', fromMe: false, id: 'M3' };
  const evilAudio = { ...okNode, url: 'http://127.0.0.1:9/x', ptt: true };
  assert.equal(t.normalize({ key, message: { videoMessage: { ...okNode, mimetype: 'video/mp4' }, audioMessage: evilAudio } }), null);
  assert.equal(t.normalize({ key, message: { audioMessage: evilAudio, imageMessage: { url: 'https://mmg.whatsapp.net/i' } } }), null);
  const n = t.normalize({ key, message: { audioMessage: { ...okNode, ptt: true } } });
  assert.equal(n.mediaNode, n.mediaNode && n.type === 'ptt' ? n.mediaNode : null, 'a single media object is the one that gets validated and downloaded');
});

test('R2: the download stream is destroyed the moment the byte limit, the deadline or the cancel signal trips', async () => {
  const slow = (chunks, gapMs) => Readable.from((async function* () { for (const c of chunks) { await new Promise((r) => setTimeout(r, gapMs)); yield c; } })());
  // byte limit: 5 chunks of 1000 under a 2500 cap → error after the third, stream destroyed, later chunks never read
  let s = slow(Array(5).fill(Buffer.alloc(1000)), 5);
  await assert.rejects(readBounded(s, { maxBytes: 2500, timeoutMs: 5000 }), /over size limit/);
  assert.equal(s.destroyed, true);
  // deadline
  s = slow(Array(50).fill(Buffer.alloc(10)), 20);
  const t0 = Date.now();
  await assert.rejects(readBounded(s, { maxBytes: 1e6, timeoutMs: 60 }), /timed out/);
  assert.ok(Date.now() - t0 < 300); assert.equal(s.destroyed, true);
  // cancel signal
  s = slow(Array(50).fill(Buffer.alloc(10)), 20);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 30);
  await assert.rejects(readBounded(s, { maxBytes: 1e6, timeoutMs: 5000, signal: ac.signal }), /cancelled/);
  assert.equal(s.destroyed, true);
  // happy path
  assert.equal((await readBounded(slow([Buffer.from('ab'), Buffer.from('cd')], 1), { maxBytes: 10, timeoutMs: 1000 })).toString(), 'abcd');
});

test('R3: after stop(), nothing is sent and in-flight work is cancelled and awaited', async () => {
  const t = tenant();
  let sent = 0; t.sock = { sendMessage: async () => { sent++; } };
  const slowJob = new Promise((r) => setTimeout(r, 50)); t.inFlight.add(slowJob);
  const p = t.sendPaced('x@s.whatsapp.net', { text: 'hi' });
  const t0 = Date.now();
  await t.stop();
  assert.ok(Date.now() - t0 >= 45, 'stop waited for the in-flight job');
  assert.equal(t.abort.signal.aborted, true, 'downloads were cancelled');
  await assert.rejects(p, /stopped/);
  assert.equal(sent, 0);
  await assert.rejects(t.sendPaced('x@s.whatsapp.net', { text: 'later' }), /stopped/);
});

test('R4: a reservation that would exceed the daily cap is refused atomically', () => {
  const t = tenant();
  t.usage = { day: t.todayKey(), seconds: 0, notified: false }; // fresh day (the tenant dir is shared across tests)
  const cap = DAILY_MINUTES_CAP * 60; // whatever the deployment's per-account cap is
  assert.equal(t.reserveUsage(cap - 50), true);
  assert.equal(t.reserveUsage(51), false, 'would exceed by one second');
  assert.equal(t.usageSecondsToday(), cap - 50, 'a refused reservation leaves the counter untouched');
  assert.equal(t.reserveUsage(50), true);
  assert.equal(t.reserveUsage(1), false);
});

test('usage history: when the day rolls over, yesterday\'s minutes are kept (minutes only), and the admin status carries them', async () => {
  const t = new Tenant({ id: 'hist1', createdAt: Date.now() }, join(process.env.DATA_DIR, 'hist1'));
  t.usage = { day: '2026-01-01', seconds: 600, notified: true };
  assert.equal(t.usageSecondsToday(), 0, 'a new day starts at zero');
  assert.deepEqual(t.usageHistory.at(-1), { day: '2026-01-01', minutes: 10 });
  assert.deepEqual(t.status({ history: true }).usageHistory.at(-1), { day: '2026-01-01', minutes: 10 });
  assert.equal(t.status({ full: true }).usageHistory, undefined, 'the link page API does not get it');
});

test('transcription totals (own and others\', counts only) survive a restart and reach only the admin status', () => {
  const dir = join(process.env.DATA_DIR, 'tot1'), rec = { id: 'tot1', createdAt: Date.now() };
  const t = new Tenant(rec, dir);
  assert.equal(t.totals.own + t.totals.others, 0);
  t.totals.own = 3; t.totals.others = 5; writeFileSync(join(dir, 'totals.json'), JSON.stringify(t.totals));
  const again = new Tenant(rec, dir);
  assert.deepEqual(again.status({ history: true }).totals, t.totals);
  assert.equal(again.status().totals, undefined, 'the owner-facing status contract is unchanged');
});

// ---- the length a message declares is the sender's word ----
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import { measureSeconds, formatOf, prepareAudio } from '../src/audio.js';
import * as serverBudget from '../src/budget.js';

test('a recording is measured, not believed: the quota follows the real length and an over-long file is refused', async () => {
  const file = join(process.env.DATA_DIR, 'tone.mp3');
  const made = spawnSync(ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-ac', '1', '-b:a', '32k', file], { stdio: 'ignore' });
  assert.equal(made.status, 0, 'ffmpeg is needed for this test');
  const real = await measureSeconds(file);
  assert.ok(real > 19 && real < 21, `measured ${real}s`);
  assert.equal(await measureSeconds(join(process.env.DATA_DIR, 'nothing-here.mp3')), null);

  // Media isolation: ffmpeg is told what the file is from its own bytes and may open only that
  // file. A playlist that points at another file (the way an HLS .m3u8 can point at a session
  // key) is not a format we hand to ffmpeg at all: nothing is followed, nothing is measured.
  const playlist = join(process.env.DATA_DIR, 'evil.ogg');
  // A real HLS playlist (ffmpeg recognises one by its TARGETDURATION / MEDIA-SEQUENCE tags): before the
  // demuxer was pinned, ffmpeg followed it by content, whatever the file was called, and decoded tone.mp3.
  writeFileSync(playlist, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:21\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:20.0,\n${file}\n#EXT-X-ENDLIST\n`);
  assert.equal(await measureSeconds(playlist), null, 'a playlist posing as a voice note measures nothing');
  const concat = join(process.env.DATA_DIR, 'evil2.mp4');
  writeFileSync(concat, `ffconcat version 1.0\nfile '${file}'\n`);
  assert.equal(await measureSeconds(concat), null);
  const prepared = await prepareAudio(concat, true);
  assert.equal(prepared.audio.name, 'evil2.mp4', 'no audio track is extracted from it either: the raw bytes go, as they are');
  prepared.cleanup();
  // What is recognised, and what is not.
  assert.equal(formatOf(Buffer.from('OggS\0\x02')), 'ogg');
  assert.equal(formatOf(Buffer.from('\0\0\0\x18ftypmp42')), 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.equal(formatOf(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), 'wav');
  assert.equal(formatOf(Buffer.from('ID3\x04\0')), 'mp3');
  assert.equal(formatOf(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mp3');
  assert.equal(formatOf(Buffer.from('#!AMR\n')), 'amr');
  assert.equal(formatOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'matroska,webm');
  for (const bad of ['#EXTM3U\n', 'ffconcat version 1.0', '<?xml', '', 'file:///etc/passwd', 'OggX']) assert.equal(formatOf(Buffer.from(bad)), null, JSON.stringify(bad));

  const t = new Tenant({ id: 'len', createdAt: Date.now() }, join(process.env.DATA_DIR, 'len')); serverBudget.__reset();
  // It declared one second; one second was reserved. The other nineteen are charged before any upload.
  serverBudget.reserve(1); t.reserveUsage(1);
  const before = t.usageSecondsToday();
  const n = { seconds: 1 };
  assert.equal(await t.holdToRealLength(n, { absPath: file }, 1), true);
  assert.ok(t.usageSecondsToday() - before >= 19); assert.ok(serverBudget.secondsToday() >= 20); assert.ok(n.seconds >= 20);
  // Really an hour: refused, and what it had reserved is given back.
  const used = t.usageSecondsToday(), server = serverBudget.secondsToday();
  serverBudget.reserve(1); t.reserveUsage(1);
  assert.equal(await t.holdToRealLength({ seconds: 1 }, { absPath: file }, 1, false, async () => 3600), false);
  assert.equal(t.usageSecondsToday(), used); assert.equal(serverBudget.secondsToday(), server);
  // Unmeasurable audio is bounded by its size; an unmeasurable video goes nowhere.
  assert.equal(await t.holdToRealLength({ seconds: 1 }, { absPath: file }, 0, true, async () => null), false);
});

test('only the owner\'s own voice can dictate in the control group', async () => {
  const t = tenant(); let probed = 0, asked = 0;
  t.deliverProbe = () => { probed++; }; t.dictationFor = async () => { asked++; return { to: 'Dana', text: 'hi' }; }; t.dictate = async () => { asked++; };
  await t.handleControlNote({ fromMe: false, isVoice: true, forwarded: false }, 'send Dana that I am late', 'body', false, {});
  assert.equal(probed, 1); assert.equal(asked, 0);
});

test('a chat bundle writes the id map once, not once per pair', () => {
  const t = new Tenant({ id: 'alt', createdAt: Date.now() }, join(process.env.DATA_DIR, 'alt'));
  const file = join(process.env.DATA_DIR, 'alt', 'altids.json');
  let writes = 0;
  const real = t.saveMap.bind(t); t.saveMap = (name, map, cap) => { if (name === 'altids.json') writes++; return real(name, map, cap); };
  const chats = Array.from({ length: 500 }, (_, i) => ({ id: `1555010${String(i).padStart(4, '0')}@s.whatsapp.net`, pnJid: `1555010${String(i).padStart(4, '0')}@s.whatsapp.net`, lidJid: `10000000${String(i).padStart(4, '0')}@lid` }));
  t.onChats(chats);
  assert.equal(writes, 1, 'one write for the bundle');
  assert.equal(t.altIds.size, 1000); assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1000, 'everything is on disk');
  t.onChats(chats); assert.equal(writes, 1, 'nothing new, nothing written');
  // A single live pair (not from a bundle) still saves at once.
  assert.equal(t.learnAltIds('15550109999@s.whatsapp.net', '100000009999@lid'), true); assert.equal(writes, 2);
});

test('a storm of contact and chat events writes each file once, a moment later; stopping writes what is pending', async () => {
  const t = new Tenant({ id: 'soon', createdAt: Date.now() }, join(process.env.DATA_DIR, 'soon'));
  let writes = 0; const real = t.saveMap.bind(t), realSet = t.saveSet.bind(t);
  t.saveMap = (n, m, c) => { writes++; return real(n, m, c); }; t.saveSet = (n, v) => { writes++; return realSet(n, v); };
  for (let i = 0; i < 300; i++) t.onContacts([{ id: `1555010${String(i).padStart(4, '0')}@s.whatsapp.net`, name: `Contact ${i}` }]);
  for (let i = 0; i < 100; i++) t.onChats([{ id: `1555020${String(i).padStart(4, '0')}@s.whatsapp.net`, archived: true }]);
  assert.equal(writes, 0, 'nothing written yet');
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(writes, 3, 'contacts, saved, archived: one write each');
  assert.equal(JSON.parse(readFileSync(join(process.env.DATA_DIR, 'soon', 'contacts.json'), 'utf8')).length, 300);
  t.onContacts([{ id: '15550109999@s.whatsapp.net', name: 'Late' }]);
  t.flushSaves(); assert.equal(writes, 5, 'stopping writes what was pending (contacts and saved)');
  assert.ok(JSON.parse(readFileSync(join(process.env.DATA_DIR, 'soon', 'contacts.json'), 'utf8')).some(([, v]) => v === 'Late'));
});

test('every post in the control group marks it unread, unless it still is; reading it on the phone re-arms it', async () => {
  const t = new Tenant({ id: 'dot', createdAt: Date.now() }, join(process.env.DATA_DIR, 'dot'));
  const marks = []; t.target = { jid: 'ctrl@g.us' }; t.archived = new Set();
  t.sock = { chatModify: async (mod, jid) => { marks.push([mod.markRead, jid]); } };
  const sent = { key: { id: 'A1' }, messageTimestamp: 1 };
  assert.equal(t.markControlUnread(sent), true); assert.deepEqual(marks, [[false, 'ctrl@g.us']]);
  assert.equal(t.markControlUnread(sent), false, 'still unread: left alone');
  t.onChats([{ id: 'ctrl@g.us', unreadCount: 0 }]); // the owner opened it on their phone
  assert.equal(t.markControlUnread(sent), true, 'read, so the next post marks it again');
  assert.equal(t.markControlUnread(sent, Date.now() + 11 * 60e3), true, 'no news of a read for ten minutes: marked again anyway');
  t.archived.add('ctrl@g.us'); t.controlUnread = false;
  assert.equal(t.markControlUnread(sent), false, 'an archived group stays as the owner left it');
});
