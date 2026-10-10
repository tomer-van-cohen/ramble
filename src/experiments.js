/**
 * What is written down about the transcription experiment, and how it is read back:
 * one record per recording — the arm, counts, seconds and dollars, never a word of it —
 * and what people did with the text afterwards. The draw itself (which recording goes to
 * which arm) is the brain's; this is the shell's bookkeeping, under DATA_DIR/experiments.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from './paths.js';

// The experiment is on while any recording is drawn into another arm (AB_SHARE_B / AB_SHARE_C,
// shares in 0–1; the brain draws, this records). Off = nothing is written down.
const share = (k) => Math.min(1, Math.max(0, Number(process.env[k] ?? 0) || 0));
export const experimentOn = () => share('AB_SHARE_B') + share('AB_SHARE_C') > 0;

const tokens = (t) => String(t || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Share of the raw transcript's words that the correction did not keep (0–1):
 * how much work the corrector had to do. Word-level, punctuation ignored. Pure.
 */
export function wordDelta(raw, fixed) {
  const a = tokens(raw), b = tokens(fixed);
  if (!a.length) return 0;
  // Longest common subsequence, on arrays small enough for the plain table.
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return Math.round((1 - prev[b.length] / a.length) * 1000) / 1000;
}

const dir = () => dataPath('experiments');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Append one record (counts and numbers only) to today's file. Never throws. */
export function record(entry) {
  try {
    mkdirSync(dir(), { recursive: true });
    appendFileSync(join(dir(), `ab-${day(entry.at || Date.now())}.jsonl`), JSON.stringify(entry) + '\n');
  } catch (e) { console.warn(`experiment record failed: ${e.message}`); }
}

/** Every record of the last `days` days, oldest first. */
export function readRecords({ days = 7 } = {}) {
  if (!existsSync(dir())) return [];
  const cutoff = day(Date.now() - (days - 1) * 86400e3);
  const out = [];
  for (const f of readdirSync(dir()).filter((f) => /^ab-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    if (f.slice(3, 13) < cutoff) continue;
    for (const line of readFileSync(join(dir(), f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
    }
  }
  return out;
}

const bucket = (s) => (s <= 15 ? '≤15s' : s <= 30 ? '15–30s' : s <= 60 ? '30–60s' : s <= 120 ? '60–120s' : '>120s');
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const p90 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };
const per1000 = (n, total) => (total ? Math.round((n / total) * 10000) / 10 : null);

/**
 * Per arm, and per arm × segment: how many recordings, how the pipeline fared
 * (fallbacks, gate drops, retries, rejected corrections), how much the corrector
 * changed, speed, cost, and what people did with the text. Pure, exported for tests.
 */
/**
 * What a spoken correction changed, as numbers only (the texts are dropped here): how many words of
 * the posted text it replaced, and which stage had it wrong — 'cleanup' when every word it brought in
 * was already in the recogniser's own text (the correction pass changed it), else 'recognition'. Pure.
 */
export function correctionStats(before, after, raw = null) {
  const a = tokens(before), b = tokens(after);
  const changed = Math.max(a.length, b.length) - Math.round((1 - wordDelta(before, after)) * a.length);
  const left = new Map(); for (const w of a) left.set(w, (left.get(w) || 0) + 1);
  const added = []; for (const w of b) { if (left.get(w)) left.set(w, left.get(w) - 1); else added.push(w); }
  const rawWords = new Set(tokens(raw));
  const stage = raw && added.length && added.every((w) => rawWords.has(w)) ? 'cleanup' : 'recognition';
  return { changed: Math.max(0, changed), added: added.length, stage };
}

/** Corrections by voice over the records: counts, gaps and which stage was wrong. No text. */
export function summarizeVoiceFix(records) {
  const v = records.filter((r) => r.kind === 'voicefix');
  const fixed = v.filter((r) => r.outcome === 'fixed');
  const n = (pred) => v.filter(pred).length;
  return {
    replies: v.length, fixed: fixed.length, notACorrection: n((r) => r.outcome === 'not-a-correction'), editFailed: n((r) => r.outcome === 'edit-failed'),
    accounts: new Set(fixed.map((r) => r.acct)).size, own: fixed.filter((r) => r.own).length, others: fixed.filter((r) => !r.own).length,
    gapMedian: median(fixed.map((r) => r.gap).filter((x) => x != null)),
    wordsChangedMedian: median(fixed.map((r) => r.changed).filter((x) => x != null)),
    recognition: fixed.filter((r) => r.stage === 'recognition').length, cleanup: fixed.filter((r) => r.stage === 'cleanup').length,
  };
}

export function summarize(records) {
  const recs = records.filter((r) => r.kind === 'recording');
  const signals = records.filter((r) => r.kind !== 'recording');
  const groups = new Map();
  const add = (key, r) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); };
  for (const r of recs) {
    const arm = r.arm || 'A';
    add(`${arm}|all`, r);
    add(`${arm}|len:${bucket(r.sec || 0)}`, r);
    add(`${arm}|lang:${r.lang && r.lang !== 'auto' ? 'pinned' : 'auto'}`, r);
    add(`${arm}|${r.video ? 'video' : 'voice'}`, r);
    add(`${arm}|${r.own ? 'own' : 'others'}`, r);
  }
  const sigFor = (arm) => signals.filter((s) => (s.arm || 'A') === arm);
  const rows = [];
  for (const [key, g] of groups) {
    const [arm, segment] = key.split('|');
    const n = g.length;
    const delivered = g.filter((r) => r.posted);
    const sig = segment === 'all' ? sigFor(arm) : [];
    const count = (k) => sig.filter((s) => s.kind === k).length;
    rows.push({
      arm, segment, n,
      minutes: Math.round(g.reduce((s, r) => s + (r.sec || 0), 0) / 60),
      fellBack: per1000(g.filter((r) => r.fallback).length, n),
      gateDrop: per1000(g.filter((r) => r.gate && r.gate !== 'ok').length, n),
      retried: per1000(g.filter((r) => r.retry).length, n),
      rewriteRejected: per1000(g.filter((r) => r.rewrite && r.rewrite !== 'ok' && r.rewrite !== 'skipped').length, n),
      deltaMedian: median(delivered.map((r) => r.delta).filter((x) => x != null)),
      deltaOver10: per1000(delivered.filter((r) => (r.delta || 0) > 0.1).length, delivered.length),
      wpsMedian: median(g.map((r) => r.wps).filter((x) => x != null)),
      sttP50: median(g.map((r) => r.stt).filter((x) => x != null)),
      sttP90: p90(g.map((r) => r.stt).filter((x) => x != null)),
      totalP50: median(g.map((r) => r.total).filter((x) => x != null)),
      usdPerMin: g.reduce((s, r) => s + (r.sec || 0), 0) ? Math.round((g.reduce((s, r) => s + (r.usd || 0), 0) / (g.reduce((s, r) => s + (r.sec || 0), 0) / 60)) * 1e5) / 1e5 : null,
      ...(segment === 'all' ? {
        reactions: per1000(count('react'), delivered.length), revokes: per1000(count('revoke'), delivered.length),
        replies: per1000(count('reply'), delivered.length),
        rerecorded: per1000(count('rerecord'), delivered.length),
        // Texts their speaker corrected (by voice or typed): a direct measure of this arm's mistakes.
        corrected: per1000(sig.filter((s) => s.kind === 'voicefix' && s.outcome === 'fixed').length, delivered.length),
        rerecordGapMedian: median(sig.filter((s) => s.kind === 'rerecord').map((s) => s.gap)),
        rerecordGaps: sig.filter((s) => s.kind === 'rerecord').map((s) => s.gap).sort((a, b) => a - b),
      } : {}),
    });
  }
  const order = { all: 0 };
  return rows.sort((x, y) => x.arm.localeCompare(y.arm) || (order[x.segment] ?? 1) - (order[y.segment] ?? 1) || x.segment.localeCompare(y.segment));
}
