/**
 * Recordings kept on purpose, to improve the product.
 *
 * Off for everyone by default. An account only ever reaches this module after
 * its owner opted in (`keepAudio`), and then a copy of the recording is stored
 * next to what the models made of it, so a model change can be judged on real
 * audio instead of a guess. Everything lands under DATA_DIR/research/<account>/
 * and is swept by age and by total size, so it cannot quietly fill the volume.
 *
 *   RESEARCH_KEEP_DAYS   how long a kept recording lives (default 30)
 *   RESEARCH_MAX_MB      total ceiling for all kept recordings (default 500)
 */
import { renameSync, copyFileSync, unlinkSync, writeFileSync, readFileSync, readdirSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { dataPath } from './paths.js';

export const RESEARCH_KEEP_DAYS = Number(process.env.RESEARCH_KEEP_DAYS ?? 30) || 0;
export const RESEARCH_MAX_MB = Number(process.env.RESEARCH_MAX_MB ?? 500) || 0;
const root = () => dataPath('research');
const safe = (s) => String(s || '').replace(/[^\w.-]/g, '_').slice(0, 80);

/**
 * Move a just-transcribed recording into the account's research folder and write
 * a sidecar with what the models produced. Returns the item name, or null.
 * Never throws: keeping data is never a reason to fail a delivery.
 */
export function archive({ accountId, mediaPath, meta = {} }) {
  try {
    if (!mediaPath || !existsSync(mediaPath)) return null;
    const dir = join(root(), safe(accountId));
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const item = `${stamp}-${safe(basename(mediaPath, extname(mediaPath)))}`;
    const audio = join(dir, item + (extname(mediaPath) || '.bin'));
    try { renameSync(mediaPath, audio); } catch { copyFileSync(mediaPath, audio); unlinkSync(mediaPath); }
    writeFileSync(join(dir, `${item}.json`), JSON.stringify({ at: Date.now(), audio: basename(audio), ...meta }, null, 2));
    return item;
  } catch (e) {
    console.warn(`research archive failed: ${e.message}`);
    return null;
  }
}

/** Add to a kept item's metadata; arrays (e.g. corrections) are appended to. False when the item is gone. */
export function annotate(accountId, item, extra = {}) {
  try {
    const file = join(root(), safe(accountId), `${safe(item)}.json`);
    if (!existsSync(file)) return false;
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(extra)) meta[k] = Array.isArray(v) && Array.isArray(meta[k]) ? [...meta[k], ...v] : v;
    writeFileSync(file, JSON.stringify(meta, null, 2));
    return true;
  } catch (e) {
    console.warn(`research annotate failed: ${e.message}`);
    return false;
  }
}

/** Metadata of what is kept for one account, newest first (no audio bytes). */
export function list(accountId) {
  const dir = join(root(), safe(accountId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const item = f.slice(0, -5);
      let meta = {}; try { meta = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { /* unreadable */ }
      let bytes = 0; try { bytes = statSync(join(dir, meta.audio || '')).size; } catch { /* gone */ }
      return { item, bytes, ...meta };
    })
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Absolute path of a kept audio file, or null. `item` is never trusted. */
export function audioPath(accountId, item) {
  const dir = join(root(), safe(accountId));
  const side = join(dir, `${safe(item)}.json`);
  if (!existsSync(side)) return null;
  try {
    const { audio } = JSON.parse(readFileSync(side, 'utf8'));
    const p = join(dir, safe(audio));
    return existsSync(p) ? p : null;
  } catch { return null; }
}

/** Drop what is too old, then the oldest until the total fits the ceiling. */
export function sweep() {
  if (!existsSync(root())) return { removed: 0, bytes: 0 };
  const files = [];
  for (const acct of readdirSync(root())) {
    const dir = join(root(), acct);
    let entries = []; try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      const p = join(dir, f);
      try { const s = statSync(p); if (s.isFile()) files.push({ p, mtime: s.mtimeMs, size: s.size }); } catch { /* gone */ }
    }
  }
  let removed = 0, freed = 0;
  const drop = (f) => { try { unlinkSync(f.p); removed++; freed += f.size; f.gone = true; } catch { /* gone */ } };
  if (RESEARCH_KEEP_DAYS > 0) {
    const cutoff = Date.now() - RESEARCH_KEEP_DAYS * 86400e3;
    for (const f of files) if (f.mtime < cutoff) drop(f);
  }
  if (RESEARCH_MAX_MB > 0) {
    const live = files.filter((f) => !f.gone).sort((a, b) => a.mtime - b.mtime);
    let total = live.reduce((n, f) => n + f.size, 0);
    for (const f of live) { if (total <= RESEARCH_MAX_MB * 1e6) break; drop(f); total -= f.size; }
  }
  if (removed) console.log(`🧹 research: removed ${removed} file(s), freed ${Math.round(freed / 1e6)} MB`);
  return { removed, bytes: freed };
}

/** Bytes kept right now, for the admin view. */
export function usage() {
  if (!existsSync(root())) return { accounts: 0, files: 0, bytes: 0 };
  let files = 0, bytes = 0, accounts = 0;
  for (const acct of readdirSync(root())) {
    accounts++;
    let entries = []; try { entries = readdirSync(join(root(), acct)); } catch { continue; }
    for (const f of entries) { try { const s = statSync(join(root(), acct, f)); if (s.isFile()) { files++; bytes += s.size; } } catch { /* gone */ } }
  }
  return { accounts, files, bytes };
}
