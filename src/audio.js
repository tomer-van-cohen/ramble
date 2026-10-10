/**
 * The recording as a file, before anything leaves: how long it really is, and the audio
 * track of a video. ffmpeg only, local files only; nothing here talks to the network.
 *
 * ffmpeg never chooses what a file is. The container format is read from the file's own
 * first bytes (sniffFormat) and forced on ffmpeg with -f; a file that is not one of the
 * handful of formats WhatsApp sends is not given to ffmpeg at all. So a playlist, a
 * concat script or any other format that makes ffmpeg open OTHER files (an HLS .m3u8
 * pointing at a session key, say) is never parsed as one: the only file ffmpeg opens is
 * the one it was given. On Linux it also runs under address-space and output-size limits.
 *
 *   FFMPEG_PATH          an ffmpeg to prefer over the bundled one
 *   FFMPEG_TIMEOUT_MS    default 120000
 *   FFMPEG_MEMORY_MB     address-space limit for ffmpeg on Linux (default 1024; 0 = none)
 */
import { readFileSync, existsSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 120_000);
const FFMPEG_MEMORY_MB = Number(process.env.FFMPEG_MEMORY_MB ?? 1024) || 0;
const MAX_AUDIO_SECONDS = 4 * 3600;
const MAX_OUTPUT_KB = 200 * 1024; // an extracted track larger than this is not a voice note

/**
 * The container format a file says it is, from its first bytes — the ffmpeg demuxer name
 * to force, or null for anything else (never handed to ffmpeg). Only what WhatsApp sends:
 * Ogg (voice notes), the MP4 family (video, m4a, 3gp, mov), MP3, WAV, AMR, ADTS AAC,
 * WebM/Matroska. Pure on the bytes; exported for tests.
 */
export function formatOf(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head);
  const at = (i, s) => b.length >= i + s.length && b.toString('latin1', i, i + s.length) === s;
  if (at(0, 'OggS')) return 'ogg';
  if (at(4, 'ftyp')) return 'mov,mp4,m4a,3gp,3g2,mj2';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(0, 'ID3')) return 'mp3';
  if (at(0, '#!AMR')) return 'amr';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska,webm';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac'; // ADTS
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'; // a bare MPEG audio frame
  return null;
}

/** formatOf() on a file; null when it cannot be read. */
export function sniffFormat(absPath) {
  try {
    const fd = openSync(absPath, 'r');
    try { const head = Buffer.alloc(16); const n = readSync(fd, head, 0, 16, 0); return formatOf(head.subarray(0, n)); } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * ffmpeg, on exactly one local file of a known format. `-f` pins the demuxer (no playlist or
 * script format can be picked by sniffing), `-protocol_whitelist file` leaves only local
 * files, `file:` names the input explicitly, -nostdin keeps it from reading anything else.
 * On Linux the process runs under an address-space limit and an output-size limit.
 */
function runFfmpeg(format, inputPath, outArgs, { stdio, timeoutMs }) {
  const args = ['-nostdin', '-hide_banner', '-y', '-protocol_whitelist', 'file', '-f', format, '-i', `file:${inputPath}`, ...outArgs];
  const bin = ffmpegBin();
  const limits = process.platform === 'linux'
    ? ['-c', `${FFMPEG_MEMORY_MB ? `ulimit -v ${FFMPEG_MEMORY_MB * 1024} 2>/dev/null; ` : ''}ulimit -f ${MAX_OUTPUT_KB} 2>/dev/null; exec "$0" "$@"`, bin, ...args]
    : null;
  const ff = limits ? spawn('/bin/sh', limits, { stdio }) : spawn(bin, args, { stdio });
  const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  return { ff, clear: () => clearTimeout(timer) };
}

function ffmpegBin() {
  // Prefer the bundled ffmpeg (ffmpeg-static) so no system install is needed.
  const cands = [process.env.FFMPEG_PATH, ffmpegStatic, 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].filter(Boolean);
  for (const c of cands) { if (c === 'ffmpeg') return c; if (existsSync(c)) return c; }
  return 'ffmpeg';
}

// Extract a small 16kHz mono mp3 audio track from a video of a known format. Returns temp path or null.
function extractAudio(videoPath) {
  const format = sniffFormat(videoPath);
  if (!format) return Promise.resolve(null);
  return new Promise((resolve) => {
    const out = join(tmpdir(), `wa_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
    // Local file in, local file out, nothing else, and a hard time limit so a malformed clip can't pin a core forever.
    const { ff, clear } = runFfmpeg(format, videoPath, ['-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-t', String(MAX_AUDIO_SECONDS), '-f', 'mp3', out], { stdio: 'ignore', timeoutMs: FFMPEG_TIMEOUT_MS });
    const done = (ok) => { clear(); if (!ok) { try { unlinkSync(out); } catch { /* none */ } } resolve(ok ? out : null); };
    ff.on('error', () => done(false));
    ff.on('close', (code) => done(code === 0 && existsSync(out)));
  });
}

/**
 * How long the recording really is, in seconds, by decoding its audio track. The length a
 * message declares is written by the sender's client and can say anything; the quota and
 * the per-recording limit must be held against the audio itself. Decoding stops just past
 * `limitSeconds`, so an over-long file costs no more than a limit-long one.
 * Returns null when ffmpeg could not tell (not installed, not decodable, timed out), and
 * without asking ffmpeg at all for a file that is not a known media format.
 */
export function measureSeconds(absPath, { limitSeconds = MAX_AUDIO_SECONDS, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  const format = sniffFormat(absPath);
  if (!format) return Promise.resolve(null);
  return new Promise((resolve) => {
    const { ff, clear } = runFfmpeg(format, absPath, ['-vn', '-t', String(limitSeconds + 1), '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], timeoutMs });
    let tail = '';
    ff.stderr.on('data', (c) => { tail = (tail + c).slice(-4000); });
    const done = (ok) => {
      clear();
      const times = ok ? [...tail.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)] : [];
      const last = times[times.length - 1];
      resolve(last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null);
    };
    ff.on('error', () => done(false));
    ff.on('close', (code) => done(code === 0));
  });
}

/**
 * The recording as the brain gets it: a buffer and a file name (for the MIME type). A
 * video's audio track is extracted first (small and robust) instead of uploading the clip;
 * if that fails the raw clip goes. Never throws. Call `cleanup()` when done.
 * @returns {Promise<{audio:{buf:Buffer,name:string}, cleanup:()=>void}>}
 */
export async function prepareAudio(absPath, isVideo) {
  const extracted = isVideo ? await extractAudio(absPath) : null;
  const path = extracted || absPath;
  const audio = { buf: readFileSync(path), name: basename(path) };
  return { audio, cleanup: () => { if (extracted) { try { unlinkSync(extracted); } catch { /* ignore */ } } } };
}
