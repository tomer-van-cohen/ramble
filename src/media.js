import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { retryNet, netWhy } from './net.js';

// Media is only ever fetched from WhatsApp's own CDN. A message carries its own
// download URL, and an unofficial client would happily follow it anywhere —
// including into the server's private network. So: https only, WhatsApp hosts
// only, the host is pinned explicitly for the download, and ONLY the validated
// media node is handed to the downloader (never the whole message, which may
// carry a second, unvalidated media object).
export const MEDIA_HOST = 'mmg.whatsapp.net';
const ALLOWED_HOST = /(^|\.)whatsapp\.net$/i;
export const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES ?? 64 * 1024 * 1024);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS ?? 90_000);
export const MAX_MEDIA_SECONDS = 4 * 3600;

const EXT = {
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'audio/amr': 'amr', 'audio/aac': 'aac',
};
function extFor(mimetype = '') {
  const base = mimetype.split(';')[0].trim();
  return EXT[base] || (base.split('/')[1] || 'bin');
}

/**
 * Is this audio/video node safe to download? Pure; exported for tests.
 * @returns {{ ok: true, host: string } | { ok: false, reason: string }}
 */
export function mediaDownloadPolicy(node) {
  if (!node || typeof node !== 'object') return { ok: false, reason: 'no media node' };
  if (!node.mediaKey) return { ok: false, reason: 'no media key' };
  const directPath = node.directPath;
  if (typeof directPath !== 'string' || !directPath.startsWith('/') || directPath.startsWith('//')) return { ok: false, reason: 'no direct path' };
  let host = MEDIA_HOST;
  if (node.url != null && node.url !== '') {
    let u;
    try { u = new URL(String(node.url)); } catch { return { ok: false, reason: 'bad url' }; }
    if (u.protocol !== 'https:') return { ok: false, reason: 'not https' };
    if (!ALLOWED_HOST.test(u.hostname) || u.port) return { ok: false, reason: `host not allowed` };
    host = u.hostname;
  }
  const len = Number(node.fileLength ?? 0);
  if (!Number.isFinite(len) || len < 0) return { ok: false, reason: 'bad length' };
  if (len > MAX_MEDIA_BYTES) return { ok: false, reason: 'too large' };
  return { ok: true, host };
}

/**
 * Read a stream into a buffer with a hard byte limit, a deadline and an abort
 * signal. The stream is DESTROYED the moment any of them trips, which cancels
 * the underlying HTTP body — nothing keeps downloading in the background.
 * Exported for tests.
 */
export function readBounded(stream, { maxBytes = MAX_MEDIA_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    const finish = (err, value) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (err) { try { stream.destroy(err); } catch { /* ignore */ } reject(err); } else resolve(value);
    };
    const onAbort = () => finish(new Error('cancelled'));
    const timer = setTimeout(() => finish(new Error('download timed out')), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (c) => { size += c.length; if (size > maxBytes) return finish(new Error('media over size limit')); chunks.push(c); });
    stream.on('end', () => finish(null, Buffer.concat(chunks)));
    stream.on('error', (e) => finish(e));
  });
}

/**
 * Decrypt + download ONE validated media node into `mediaDir` (one per account).
 * Returns { absPath, mimetype } or null. The caller deletes the file when done.
 * @param {'audio'|'video'} type
 */
export async function saveMedia(node, type, idBase, mediaDir, { signal } = {}) {
  const policy = mediaDownloadPolicy(node);
  if (!policy.ok) { console.warn(`   ⚠️  media refused (${policy.reason})`); return null; }
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  const id = String(idBase || Date.now()).replace(/[^\w.-]/g, '_');
  const absPath = join(mediaDir, `${id}.${extFor(node.mimetype)}`);
  if (existsSync(absPath)) return { absPath, mimetype: node.mimetype };
  try {
    // Only the validated node's key + direct path reach the downloader; the host
    // is the one the policy approved, never one taken from elsewhere in the message.
    // A connection that drops gets one more try: the whole download starts over.
    const buffer = await retryNet(async () => {
      const stream = await downloadContentFromMessage({ mediaKey: node.mediaKey, directPath: node.directPath }, type, { host: policy.host });
      return readBounded(stream, { signal });
    }, { label: 'media download', signal });
    if (!buffer?.length) return null;
    writeFileSync(absPath, buffer, { mode: 0o600 });
    return { absPath, mimetype: node.mimetype };
  } catch (e) {
    console.warn(`   ⚠️  media download failed: ${netWhy(e)}`);
    return null;
  }
}

export function deleteMediaFile(media) {
  if (!media?.absPath) return;
  try { unlinkSync(media.absPath); } catch { /* already gone */ }
}

/** Remove files left behind by a crash or restart. Media never outlives its transcription. */
export function sweepMediaDir(mediaDir, olderThanMs = 0) {
  let n = 0;
  try {
    for (const f of readdirSync(mediaDir)) {
      const p = join(mediaDir, f);
      try { if (Date.now() - statSync(p).mtimeMs >= olderThanMs) { unlinkSync(p); n++; } } catch { /* ignore */ }
    }
  } catch { /* no dir */ }
  return n;
}
