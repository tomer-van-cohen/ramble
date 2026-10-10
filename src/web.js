/**
 * The public site: a landing page, the link page (QR), a private manage page per
 * account, and an admin health view. No page ever shows message content.
 *
 * Security posture:
 *   - every response carries a strict CSP (scripts only with a per-response
 *     nonce), no referrer off-site, nosniff, no framing; private pages are no-store
 *   - each browser has its own session (an HttpOnly cookie; door.js): from signing up, from a support
 *     link (/admin/link), or from a code the owner sends in their control group
 *   - every state-changing POST must come from this site (Origin / Sec-Fetch-Site)
 *   - admin uses Basic auth with a per-IP failure limit; sign-ups are limited
 *     per IP and by a global cap on accounts that have not scanned yet
 */
import express from 'express';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as registry from './registry.js';
import { LANGUAGES, PRODUCT_NAME, DAILY_MINUTES_CAP } from './tenant.js';
import { brain } from './brain/index.js';
const { plans: PLANS, planLabel } = brain.info();
import { GLOBAL_DAILY_MINUTES, secondsToday } from './budget.js';
import * as research from './research.js';
import * as experiments from './experiments.js';
import { features, setFeature, FEATURES, settings, setSetting, SETTINGS } from './features.js';
import { dataDirIsMount, dataPath } from './paths.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { LOGO_SVG, LOGO_DATA_URI } from './logo.js';
import { normalizePhone, COUNTRIES, countryFromLanguage } from './pairing.js';
import { speechPerMinute } from './cost.js';
import * as visitors from './visitors.js';
import * as health from './health.js';
import { HE, landingHe, howHe, privacyHe } from './site-he.js';
import { SITE_URL } from './settings.js';
import { startSession, hasSession, issueEntry, useEntry, openDoor, doorState, DOOR_RE } from './door.js';

const REPO_URL = process.env.REPO_URL || 'https://github.com/tomer-van-cohen/ramble';
// build-info.json is written by scripts/deploy.sh (gitignored, uploaded with the tree); a local
// run or a build without it says so, it never guesses.
function buildInfo() {
  try {
    const j = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'));
    return { shell: String(j.shell || '').slice(0, 40) || null, brain: String(j.brain || '').slice(0, 40) || null, repo: String(j.repo || REPO_URL), builtAt: String(j.builtAt || '') || null };
  } catch { return { shell: null, brain: null, repo: REPO_URL, builtAt: null }; }
}
const TAGLINE = 'Ramble, baby. Talk into WhatsApp however it comes out; every voice note shows up as clean text right under it.';
// One home: requests arriving on a retired domain are sent to the current one, path and all.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').toLowerCase();
const LEGACY_HOSTS = new Set((process.env.LEGACY_HOSTS || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD || '';
// Optional, and best long and random too: then a sign-in needs both, and a guess has to get two secrets right.
const ADMIN_USER = process.env.ADMIN_USER || '';
const INVITE_CODE = process.env.INVITE_CODE || ''; // optional: closed beta behind a code
const ID_RE = /^[a-z0-9]{1,64}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- limiters (in-memory, per process) ----------
const STARTS_PER_HOUR = Number(process.env.STARTS_PER_HOUR ?? 5);
const ADMIN_FAILS_PER_15MIN = 10;
function windowLimiter(max, windowMs) {
  const hits = new Map(); // ip -> [timestamps]
  let lastPrune = Date.now();
  const prune = () => { const now = Date.now(); for (const [ip, arr] of hits) { const keep = arr.filter((t) => now - t < windowMs); keep.length ? hits.set(ip, keep) : hits.delete(ip); } lastPrune = now; };
  return {
    blocked(ip) { const now = Date.now(); if (now - lastPrune > windowMs) prune(); return (hits.get(ip) || []).filter((t) => now - t < windowMs).length >= max; },
    hit(ip) { const now = Date.now(); const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs); arr.push(now); hits.set(ip, arr); },
  };
}
const startLimiter = windowLimiter(STARTS_PER_HOUR, 3600e3);
const adminFailLimiter = windowLimiter(ADMIN_FAILS_PER_15MIN, 15 * 60e3);

// ---------- helpers ----------
function guessLanguage(acceptLanguage = '') {
  const first = String(acceptLanguage).split(',')[0]?.trim().toLowerCase().split('-')[0] || '';
  return LANGUAGES.some(([v]) => v && v === first) ? first : '';
}
// The site's language. Hebrew for a browser whose first language is Hebrew (the device's language,
// not where it is); everyone else gets English. ?lang=he|en switches and is remembered in a cookie.
const SITE_LANGS = new Set(['he', 'en']);
function siteLang(req) {
  const c = cookies(req).lang;
  if (SITE_LANGS.has(c)) return c;
  const first = String(req.get('accept-language') || '').split(',')[0].trim().toLowerCase();
  return /^(he|iw)\b/.test(first) ? 'he' : 'en';
}
/** Whether Hebrew is among the browser's languages at all: then English pages offer it. */
const knowsHebrew = (req) => /(^|,)\s*(he|iw)\b/i.test(String(req.get('accept-language') || ''));
const mark = `<a class="mark" href="/">${LOGO_SVG}<span>${esc(PRODUCT_NAME)}</span></a>`;
// A voice note and its text, drawn as a chat — the product in one glance.
const WAVE_SVG = `<svg class="wave" width="130" height="22" viewBox="0 0 130 22" aria-hidden="true">${[6, 10, 16, 8, 20, 12, 7, 14, 18, 9, 5, 13, 17, 11, 6, 15, 19, 8, 12, 7, 16, 10, 5, 9, 14, 6].map((h, i) => `<rect x="${i * 5}" y="${(22 - h) / 2}" width="3" height="${h}" rx="1.5" fill="currentColor"/>`).join('')}</svg>`;
const DEMO = `<div class="chat" role="img" aria-label="A WhatsApp voice note with its text posted right under it">
<div class="b in"><span class="av">D</span><svg class="play" width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M1 1.2v13.6L13 8z" fill="currentColor"/></svg>${WAVE_SVG}<span class="dur">1:47</span></div>
<div class="b out"><span class="quo">Voice message · 1:47</span><p>I'm stuck in traffic, I'll be there in about twenty minutes. Start without me and order me the same as last time, and if they have the lemonade get me a big one.</p><span class="t">9:41</span></div>
</div>`;
// The three typefaces are served from here: the CSP allows no third-party origin.
const FONT_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));
const FONT_FILES = new Set(['bricolage.woff2', 'geist.woff2', 'geist-mono.woff2']);
// The repo's star count, for the landing page: refreshed in the background at most hourly,
// and simply absent until GitHub answers (it won't while the repo is private).
const GH_REPO = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(REPO_URL)?.[1] || '';
let stars = null, starsAt = 0;
function refreshStars() {
  if (!GH_REPO || process.env.GITHUB_STARS === 'off' || Date.now() - starsAt < 3600e3) return;
  starsAt = Date.now();
  fetch(`https://api.github.com/repos/${GH_REPO}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': PRODUCT_NAME }, signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) stars = Number.isInteger(j.stargazers_count) ? j.stargazers_count : null; }).catch(() => {});
}
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
// Tolerant cookie parser: a malformed value is simply absent (never an exception).
const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return ''; } };
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => { const i = p.indexOf('='); return i < 0 ? [] : [p.slice(0, i).trim(), safeDecode(p.slice(i + 1).trim())]; }).filter(([k, v]) => k && v));
const setSession = (req, res, t, token = startSession(t)) => res.append('Set-Cookie', `rl=${t.id}.${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
const clearSession = (req, res) => res.append('Set-Cookie', `rl=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);

const TAGLINE_HE = 'פטפטו חופשי. כל הודעה קולית בוואטסאפ מופיעה כטקסט נקי, ממש מתחתיה.';
// Right to left, for the Hebrew site: the chat bubbles, quotes and fields mirror; phone numbers and codes stay left to right.
const RTL_CSS = `[dir=rtl] body{font-family:Geist,system-ui,-apple-system,"Segoe UI","Arial Hebrew",Arial,sans-serif}
[dir=rtl]{--disp:"Bricolage Grotesque",system-ui,-apple-system,"Segoe UI","Arial Hebrew",Arial,sans-serif}
[dir=rtl] h1,[dir=rtl] h2,[dir=rtl] h3{letter-spacing:-.015em}
[dir=rtl] .chat{text-align:right}[dir=rtl] .b.in{border-radius:20px 8px 20px 20px;padding:12px 12px 12px 16px}[dir=rtl] .b.out{border-radius:8px 20px 20px 20px}
[dir=rtl] .b .quo{border-left:0;border-right:3px solid #1fa855}
[dir=rtl] .say .me{border-radius:8px 22px 22px 22px}[dir=rtl] .say .them{border-radius:22px 8px 22px 22px}
[dir=rtl] .mini .me{border-radius:6px 18px 18px 18px}[dir=rtl] .mini .bot{border-radius:18px 6px 18px 18px}[dir=rtl] .mini .q{border-left:0;border-right:4px solid #0a7a43}
[dir=rtl] select{padding-right:14px;padding-left:40px;background-position:left 14px center}
[dir=rtl] .howto li{padding:4px 44px 0 0}[dir=rtl] .howto li::before{left:auto;right:0}
[dir=rtl] td,[dir=rtl] th{text-align:right}
[dir=rtl] .mini small{font-family:inherit;letter-spacing:0;font-size:13px}[dir=rtl] .tel input::placeholder{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;letter-spacing:0}
.tel,.code{direction:ltr}`;

// What a link to the site shows when it is shared (WhatsApp, social networks): one picture and one text,
// in Hebrew, whatever language the page is in. Crawlers ask for no language, and nearly everyone who
// shares the link writes to people in Hebrew. The picture is src/assets/og.png (1200×630).
const SHARE_TITLE = 'Ramble · פטפטו חופשי. אין דאגות.';
const SHARE_TEXT = 'כל הודעה קולית בוואטסאפ הופכת לטקסט נקי, ממש מתחתיה.';
const shareTags = (res) => {
  const origin = SITE_URL || `${res.req?.protocol || 'https'}://${res.req?.get?.('host') || ''}`;
  const url = `${origin}${String(res.req?.originalUrl || '/').split('?')[0]}`;
  return `<meta property="og:site_name" content="Ramble"><meta property="og:type" content="website"><meta property="og:locale" content="he_IL">
<meta property="og:url" content="${esc(url)}"><meta property="og:title" content="${esc(SHARE_TITLE)}"><meta property="og:description" content="${esc(SHARE_TEXT)}">
<meta property="og:image" content="${origin}/og.png"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Ramble: כל הודעה קולית בוואטסאפ הופכת לטקסט, ממש מתחתיה.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(SHARE_TITLE)}"><meta name="twitter:description" content="${esc(SHARE_TEXT)}"><meta name="twitter:image" content="${origin}/og.png">`;
};

function page(res, title, body, { poll = null, wide = false, nav = '', bare = false } = {}) {
  const nonce = res.locals.nonce;
  const he = res.locals.lang === 'he', TAG = he ? TAGLINE_HE : TAGLINE;
  return `<!doctype html><html lang="${he ? 'he' : 'en'}" dir="${he ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#faf7f2"><meta name="color-scheme" content="light"><title>${esc(title)}</title>
<meta name="description" content="${esc(TAG)}">
${shareTags(res)}
<link rel="icon" href="${LOGO_DATA_URI}" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="/icon-180.png">
<style nonce="${nonce}">
@font-face{font-family:"Bricolage Grotesque";font-weight:700 800;font-stretch:100%;font-display:swap;src:url(/fonts/bricolage.woff2) format("woff2")}
@font-face{font-family:Geist;font-weight:400 600;font-display:swap;src:url(/fonts/geist.woff2) format("woff2")}
@font-face{font-family:"Geist Mono";font-weight:400 500;font-display:swap;src:url(/fonts/geist-mono.woff2) format("woff2")}
:root{--bg:#faf7f2;--card:#fff;--ink:#121212;--mute:#5c5a55;--line:#e4dfd5;--green:#25d366;--chat:#efeae0;--out:#d9fdd3;--danger:#b3261e;--disp:"Bricolage Grotesque","Helvetica Neue",Helvetica,sans-serif;--mono:"Geist Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 Geist,"Helvetica Neue",Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1160px;margin:0 auto;padding-left:20px;padding-right:20px}
.narrow{max-width:500px}
.nav{display:flex;align-items:center;justify-content:space-between;height:72px}
.mark{display:inline-flex;align-items:center;gap:10px;font-family:var(--disp);font-weight:800;font-size:22px;letter-spacing:-.03em;color:var(--ink);text-decoration:none}
.mark svg{width:30px;height:30px;display:block}
.navlink{display:inline-flex;align-items:center;height:44px;font-size:16px;font-weight:500;text-decoration:none}
h1,h2,h3{font-family:var(--disp);font-weight:800;letter-spacing:-.04em;line-height:.95;margin:0}
h1{font-size:clamp(40px,12.6vw,148px);white-space:nowrap;line-height:.92}h1 span{color:#8c877c}
h1.small{font-size:44px;white-space:normal;margin:12px 0 20px}
h2{font-size:clamp(40px,6vw,68px)}h3{font-size:22px;letter-spacing:-.03em;line-height:1}
p{margin:0}.muted{color:var(--mute);font-size:15px}.center{text-align:center}
main.narrow{padding-bottom:40px}main.narrow>p{margin:12px 0;color:var(--mute)}main.narrow b{color:var(--ink);font-weight:600}
.hero{display:flex;flex-direction:column;align-items:flex-start;gap:24px;padding-top:36px;padding-bottom:72px}
.sub{font-size:19px;line-height:1.4;color:var(--mute);max-width:560px;text-wrap:balance}
.start{display:flex;flex-direction:column;gap:14px;width:100%}
.cta{display:inline-flex;align-items:center;justify-content:center;width:100%;height:60px;padding:0 34px;border:0;border-radius:999px;background:var(--green);color:var(--ink);font:inherit;font-size:18px;font-weight:600;text-decoration:none;cursor:pointer}
.cta:active{transform:translateY(1px)}
.fine{color:var(--mute);font-size:14px}.start .fine{text-align:center}
.safe{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;justify-content:center;gap:4px 18px;color:var(--mute);font-size:14px;line-height:1.4}.safe li{display:flex;align-items:center;gap:7px}.safe svg{flex:none}
.invited{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:999px;background:var(--ink);color:#fff;font-size:13px;font-weight:600}
label{display:block;font-size:15px;color:var(--mute);margin:0 0 8px}
select,input[type=text]{width:100%;height:52px;font:inherit;font-size:16px;padding:0 14px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:var(--ink);appearance:none}
select{padding-right:40px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='9' viewBox='0 0 14 9'%3E%3Cpath d='M1 1l6 6 6-6' fill='none' stroke='%235c5a55' stroke-width='2'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
.chat{width:100%;max-width:520px;align-self:center;margin-top:16px;background:var(--chat);border-radius:32px;padding:16px;display:flex;flex-direction:column;gap:12px;text-align:left}
.b{color:#111b21;font-size:15px;line-height:1.45}
.b.in{align-self:flex-start;display:flex;align-items:center;gap:12px;background:#fff;border-radius:8px 20px 20px 20px;padding:12px 16px 12px 12px}
.b.out{align-self:flex-end;max-width:88%;background:var(--out);border-radius:20px 8px 20px 20px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.b .av{width:34px;height:34px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:16px;flex:none}
.b .play,.b .dur{color:var(--mute);flex:none}.b .wave{color:#8a8f8c;flex:none;max-width:40vw}
.b .dur,.b .t{font-family:var(--mono);font-size:12px}
.b .quo{border-left:3px solid #1fa855;background:rgba(0,0,0,.05);border-radius:6px;padding:6px 10px;font-size:13px;color:#2f5a43}
.b.out b{font-weight:700;line-height:1.4}.b .t{align-self:flex-end;font-size:11px;color:#54705f}
.band{border-top:1px solid var(--line);padding:64px 0}
.both{display:flex;flex-direction:column;gap:28px}
.lead{display:flex;flex-direction:column;gap:14px}.lead p{color:var(--mute);max-width:440px}
.say{background:var(--chat);border-radius:32px;padding:16px;display:flex;flex-direction:column;gap:12px}
.say span{font-family:var(--disp);font-weight:700;font-size:22px;line-height:1.1;letter-spacing:-.025em;color:#111b21;padding:16px 20px}
.say .me{align-self:flex-end;background:var(--out);border-radius:22px 8px 22px 22px}.say .them{align-self:flex-start;background:#fff;border-radius:8px 22px 22px 22px}
.facts{display:flex;flex-direction:column;gap:16px;margin-top:32px;padding-top:24px;border-top:1px solid var(--line);color:var(--mute)}.facts b{color:var(--ink);font-weight:600}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:24px;counter-reset:s}
.steps li{counter-increment:s;display:flex;align-items:center;gap:16px;font-family:var(--disp);font-weight:700;font-size:24px;line-height:1.1;letter-spacing:-.025em}
.steps li::before{content:counter(s);width:44px;height:44px;border-radius:50%;background:var(--green);display:grid;place-items:center;font-weight:800;font-size:20px;flex:none}
.steps.long li{align-items:flex-start}.steps li div{display:flex;flex-direction:column;gap:8px}.steps li span{font:400 17px/1.5 Geist,"Helvetica Neue",Helvetica,sans-serif;letter-spacing:0;color:var(--mute)}
.howhero{display:flex;flex-direction:column;gap:16px;padding-top:56px;padding-bottom:72px}.howhero h1{font-size:clamp(40px,11vw,124px)}
.facts.plain{margin-top:28px;padding-top:0;border:0}.facts.plain:first-child{margin-top:0}
.asks{display:flex;flex-direction:column;gap:48px;margin-top:48px}.ask{display:flex;flex-direction:column;gap:20px}
.ask h3{font-size:28px;font-weight:700}.ask p{color:var(--mute);max-width:460px;margin-top:10px}.intro{color:var(--mute);margin-top:14px}
.mini{background:var(--chat);border-radius:28px;padding:16px;display:flex;flex-direction:column;gap:10px}
.mini small{font-family:var(--mono);font-size:12px;letter-spacing:.04em;color:var(--mute);padding:0 4px 4px}
.mini div{max-width:86%;padding:10px 14px;font-size:15px;line-height:1.45;color:#111b21}.mini b{font-weight:600}
.mini .me{align-self:flex-end;background:var(--out);border-radius:18px 6px 18px 18px}.mini .bot{align-self:flex-start;background:#fff;border-radius:6px 18px 18px 18px}
.mini .q{display:block;border-left:4px solid #0a7a43;background:rgba(0,0,0,.06);border-radius:8px;padding:6px 10px;margin:-2px -4px 6px;font-size:13px;line-height:1.35;color:#4f5f56;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}.mini .q b{display:block;color:#0a7a43}
.mini .vn{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--mute);font-family:var(--mono);font-size:12px}.mini .vn em{flex-basis:100%;font:italic 12px Geist,sans-serif}.mini .vn .wave{color:#6f8f7a;width:90px}
.oss{display:flex;flex-direction:column;align-items:flex-start;gap:28px}.oss h2{font-size:clamp(36px,4vw,44px)}.oss p{color:var(--mute);margin-top:10px}
.gh{display:inline-flex;align-items:stretch;height:56px;border-radius:999px;overflow:hidden;border:1.5px solid var(--ink);text-decoration:none;font-size:16px;font-weight:600;flex:none}
.gh span{display:flex;align-items:center;gap:10px;padding:0 22px;background:var(--ink);color:#fff}.gh span+span{gap:8px;padding:0 20px 0 16px;background:var(--card);color:var(--ink);font-family:var(--mono);font-size:15px;font-weight:400}
.close{background:var(--ink);padding:96px 0}.close .wrap{display:flex;flex-direction:column;align-items:center;gap:28px;text-align:center}
.close h2{color:#fff;font-size:clamp(56px,8vw,112px)}.close .start{align-items:center;max-width:420px}.close .fine{color:#a9a49a}.close .fine a{color:#fff}
.foot{display:flex;flex-direction:column;gap:14px;padding-top:36px;padding-bottom:44px;color:var(--mute);font-size:14px}.foot nav{display:flex;gap:22px}
.pill{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--line);font-size:13px;font-weight:600;color:var(--mute)}
.pill.ok{background:var(--ink);border-color:var(--ink);color:#fff}
.pill i{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block}.pill.ok i{background:var(--green)}
#box{display:flex;flex-direction:column;gap:14px;padding:12px 0 28px}#box .pill{align-self:flex-start}
#box h1{font-size:56px;white-space:normal}#box p{color:var(--mute)}#box p.go{color:var(--ink);font-size:19px}#box .cta{margin:6px 0 4px}
#fx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9}
.tools{display:none;flex-direction:column;gap:18px;border-top:1px solid var(--line);padding:22px 0 8px}.on .tools{display:flex}
.tools form{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.tools label{margin:0;flex:none}.tools select{flex:1;min-width:160px;height:44px}
.quiet{background:none;border:0;padding:0;color:var(--danger);font:inherit;font-size:15px;font-weight:600;text-decoration:underline;cursor:pointer}
.qr{display:block;width:100%;max-width:302px;margin:8px auto;border-radius:24px;background:#fff;padding:16px;border:1px solid var(--line)}
.code{font-family:var(--mono);font-size:44px;font-weight:500;letter-spacing:.12em;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:24px;padding:22px 12px;margin:8px 0}.code i{font-style:normal;color:var(--mute);margin:0 4px}
a.swap{display:inline-block;margin-top:8px;color:var(--mute);font-size:15px}
button.code{display:block;width:100%;color:var(--ink);cursor:pointer;margin:4px 0 0}
.phone{display:flex;flex-direction:column;gap:12px;width:100%}.phone label{margin:0;color:var(--ink);font-weight:600;font-size:16px}
.tel{display:flex;align-items:stretch;height:66px;border:1.5px solid var(--line);border-radius:18px;background:var(--card);overflow:hidden}.tel:focus-within{border-color:var(--ink)}
.cc{position:relative;display:flex;align-items:center;gap:6px;padding:0 12px 0 16px;border-right:1px solid var(--line);flex:none;font-size:19px;font-weight:600}
.cc em{font-style:normal;font-size:24px;line-height:1}.cc svg{color:var(--mute)}
.cc select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:16px}
.tel input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--ink);font:500 22px/1 var(--mono);letter-spacing:.02em;padding:0 16px}
.tel input::placeholder{color:#b8b3a8}
.hint{font-size:15px;color:var(--mute);min-height:22px}.hint b{color:var(--ink);font-family:var(--mono);font-weight:500}
.howto{list-style:none;counter-reset:h;margin:6px 0 2px;padding:0;display:flex;flex-direction:column;gap:12px;width:100%}
.howto li{counter-increment:h;position:relative;min-height:30px;padding:4px 0 0 44px;font-size:17px;line-height:1.35;color:var(--ink)}
.howto li::before{content:counter(h);position:absolute;left:0;top:0;width:30px;height:30px;border-radius:50%;background:var(--chat);display:grid;place-items:center;font-weight:700;font-size:15px}
.row{border-top:1px solid var(--line);padding:22px 0;display:flex;flex-direction:column;align-items:flex-start;gap:12px}.row form{width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:12px}
.after{display:none}.on .after{display:flex}
code{font-family:var(--mono);font-size:13px;word-break:break-all}.row>code{display:block;width:100%;background:var(--chat);border-radius:12px;padding:12px 14px}
.btn{display:inline-flex;align-items:center;height:44px;padding:0 18px;border-radius:999px;border:1.5px solid var(--ink);background:transparent;color:var(--ink);font:inherit;font-size:15px;font-weight:600;cursor:pointer}
button.danger{width:100%;height:52px;border-radius:999px;border:1.5px solid var(--danger);background:transparent;color:var(--danger);font:inherit;font-size:16px;font-weight:600;cursor:pointer}
b.danger{color:var(--danger)}.ok{color:#0a6b3c}
.legal section{border-top:1px solid var(--line);padding:24px 0;display:flex;flex-direction:column;gap:10px}.legal p{color:var(--mute);font-size:16px}
.back{display:block;text-align:center;padding:12px 0 8px;color:var(--mute);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:22px;overflow-x:auto}
table{border-collapse:collapse;font-size:14px;white-space:nowrap}th,td{padding:4px 8px;text-align:left}
@media(min-width:860px){
.wrap{padding-left:40px;padding-right:40px}.narrow{padding-left:20px;padding-right:20px}.nav{height:88px}
.hero{align-items:center;text-align:center;gap:32px;padding-top:72px;padding-bottom:96px}.sub{font-size:24px}
.start{align-items:center;width:auto}.cta{width:auto}.start input{width:320px}
.chat{margin-top:24px;padding:24px}.b{font-size:16px}
.band{padding:96px 0}.both{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}.lead h2{font-size:clamp(40px,4.4vw,64px);white-space:nowrap}.lead p{font-size:20px}
.say{padding:28px;gap:16px}.say span{font-size:30px;padding:20px 28px}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:56px;padding-top:32px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:48px}.steps li{flex-direction:column;align-items:flex-start;gap:20px;font-size:32px}
.oss{flex-direction:row;align-items:center;justify-content:space-between}.oss p{font-size:19px}
.howhero{gap:24px;padding-top:96px;padding-bottom:110px}
.asks{gap:72px;margin-top:72px}.ask{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}.ask h3{font-size:40px}.ask p{font-size:19px;margin-top:14px}.intro{font-size:20px}
.mini{padding:24px}.mini div{font-size:16px}
.close{padding:140px 0}.close .wrap{gap:40px}
.foot{flex-direction:row;align-items:center;justify-content:space-between}
}
${he ? RTL_CSS : ''}
</style></head><body>${bare ? '' : `<header class="nav wrap${wide ? '' : ' narrow'}">${mark}${nav}</header>`}<main${wide ? '' : ' class="wrap narrow"'}>${body}</main>${poll ? `<script nonce="${nonce}">document.addEventListener('DOMContentLoaded',()=>{${poll}\n});</script>` : ''}</body></html>`;
}

// ---------- who signed up (coarse, for the admin page) ----------
// Device and browser from the agent string: a label, never the string itself.
function deviceOf(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  const app = /FBAN|FBAV/.test(ua) ? 'Facebook app' : /Instagram/.test(ua) ? 'Instagram app' : /LinkedInApp/.test(ua) ? 'LinkedIn app' : /WhatsApp/.test(ua) ? 'WhatsApp' : /Telegram/.test(ua) ? 'Telegram'
    : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, app].filter(Boolean).join(' · ') || (ua ? 'Other' : 'Unknown');
}
// A country: from the edge's geo header when a proxy in front sends one, else the region in the browser's language.
function countryOf(req) {
  const edge = String(req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || req.get('x-country-code') || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(edge) && edge !== 'XX') return { code: edge, how: 'network' };
  const region = /^[a-z]{2,3}-([a-z]{2})\b/i.exec(String(req.get('accept-language') || '').split(',')[0].trim())?.[1];
  return region ? { code: region.toUpperCase(), how: 'browser language' } : null;
}
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => { try { return regionNames.of(code) || code; } catch { return code; } };
const flag = (code) => (/^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
// Where they came from: the referring site's host (the landing page reports it), or an invite.
const sourceHost = (v) => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '').slice(0, 80) : ''; } catch { return ''; } };
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|preview|externalhit|^WhatsApp\/|^curl|^wget|python|go-http|node-fetch|axios|undici|headless|lighthouse|uptime|monitor|scanner/i;
const TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

// ---------- admin page ----------
// One card per account, newest activity first: who it is (WhatsApp name and number),
// whether it works, what it used, and the support tools folded underneath. Never content.
const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const when = (ms) => (ms ? `<time title="${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC">${ago(ms)}</time>` : '—');
const phoneText = (d) => (d ? `+${d}` : '');
// The last 7 UTC days before today and today itself, as small bars.
function usageBars(history = [], today = 0) {
  const byDay = new Map(history.map((h) => [h.day, h.minutes]));
  const days = Array.from({ length: 8 }, (_, i) => { const d = new Date(Date.now() - (7 - i) * 864e5).toISOString().slice(0, 10); return [d, i === 7 ? today : byDay.get(d) || 0]; });
  const max = Math.max(1, ...days.map(([, m]) => m));
  const total = days.reduce((a, [, m]) => a + m, 0);
  return `<svg class="bars" viewBox="0 0 80 34" preserveAspectRatio="none" role="img" aria-label="Minutes of audio per day, last 8 days">${days.map(([d, m], i) => { const h = Math.max(1.5, (m / max) * 34); return `<rect x="${i * 10 + 1}" y="${(34 - h).toFixed(1)}" width="8" height="${h.toFixed(1)}" rx="1.5"${i === 7 ? ' class="now"' : ''}><title>${i === 7 ? 'today' : d}: ${m} min</title></rect>`; }).join('')}</svg><span class="muted">${total} min in 8 days</span>`;
}
function stateOf(t) {
  if (t.ready && t.lastError && Date.now() - t.lastError.at < 864e5) return ['warn', 'Connected, recent error'];
  if (t.ready) return ['ok', 'Connected'];
  if (!t.linkedAt) return ['wait', 'Waiting to link'];
  return ['bad', { logged_out: 'Logged out of WhatsApp', qr: 'Needs a new scan', reconnecting: 'Reconnecting', starting: 'Starting' }[t.mode] || `Offline (${t.mode})`];
}
const nonceStyle = (nonce, css) => `<style nonce="${nonce}">${css}</style>`;
const ADMIN_CSS = `
.fbl{display:flex;flex-direction:column;gap:10px;margin:0 0 8px}.fbi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 16px}
.fbi.new{border-color:var(--ink)}.fbi p{white-space:pre-wrap;word-break:break-word;color:var(--ink);font-size:15px}.fbi .when{color:var(--mute);font-size:13px;margin-bottom:4px}
.adm{padding-bottom:64px}.adm h1.small{margin:4px 0 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px 16px}
.tile small{display:block;color:var(--mute);font-size:13px}.tile b{font-family:var(--disp);font-size:30px;letter-spacing:-.03em;line-height:1.1}.tile span{color:var(--mute);font-size:14px}.tile b .danger{color:var(--danger);font-size:22px}
.adbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
.adbar input{flex:1 1 240px;height:44px;border-radius:999px;padding:0 18px}
.chip{height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);font:inherit;font-size:14px;cursor:pointer;color:var(--ink)}
.chip[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
.acct{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;margin-bottom:12px}
.acct[hidden]{display:none}
.who{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px}
.who h3{font-size:22px}.who a{font-family:var(--mono);font-size:15px}.who code{color:var(--mute);font-size:12px}
.dot{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;padding:3px 10px;border-radius:999px;margin-left:auto}
.dot::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.dot.ok{color:#0a6b3c;background:#e3f6ea}.dot.warn{color:#8a5a00;background:#fff3d6}.dot.bad{color:var(--danger);background:#fbe7e5}.dot.wait{color:var(--mute);background:var(--chat)}
.when{color:var(--mute);font-size:14px;margin:4px 0 14px}
.facts2{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px 20px}
.facts2 div{min-width:0}.facts2 small{display:block;color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.facts2 p{font-size:15px;overflow-wrap:anywhere}.facts2 .muted{font-size:13px}
.bars{display:block;width:100%;max-width:200px;height:34px;margin:4px 0 2px}
.bars rect{fill:var(--green)}.bars rect.now{fill:var(--ink)}
.err{margin-top:14px;padding:10px 14px;border-radius:12px;background:#fbe7e5;color:var(--danger);font-size:14px;overflow-wrap:anywhere}
.acct details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.acct summary{cursor:pointer;font-size:14px;font-weight:600;color:var(--mute)}
.ops{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:12px}
.ops form{display:flex;gap:8px;align-items:flex-end}.ops label{margin:0 0 4px;font-size:13px}.ops .f{flex:1;min-width:0}
.ops select,.ops input[type=text]{height:40px;border-radius:10px;font-size:14px}
.ops .btn{height:40px;padding:0 14px;font-size:14px;white-space:nowrap}
.adout{margin-top:10px;font-size:13px;font-family:var(--mono);overflow-wrap:anywhere;color:var(--mute)}
.empty{color:var(--mute);padding:24px 0}
.alist{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.arow{display:grid;grid-template-columns:14px minmax(0,2.2fr) minmax(0,1fr) minmax(0,2fr);gap:4px 12px;align-items:center;padding:10px 14px;border-top:1px solid var(--line);text-decoration:none;font-size:14px}
.arow:first-child{border-top:0}.arow:hover{background:var(--chat)}.arow>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arow .dot{margin:0;padding:0;width:10px;height:10px;background:currentColor;font-size:0}.arow .dot::before{display:none}
@media(max-width:700px){.arow{grid-template-columns:14px minmax(0,1fr)}.arow>span:nth-child(n+3){grid-column:2}}
.pager{display:flex;gap:10px;align-items:center;justify-content:center;margin:16px 0}
.sorts{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.back2{display:inline-block;margin:0 0 14px;font-size:14px;color:var(--mute)}
.cmds ul{list-style:none;margin:8px 0 0;padding:0;font-size:14px}.cmds li{padding:3px 0;overflow-wrap:anywhere}.cmds li .muted{display:inline-block;min-width:64px}
.funnel{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;margin-bottom:28px}
.fttl{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:6px}.fttl h2,.sect{font-size:28px}.fttl nav{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;text-decoration:none}
.sorts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}.sorts .muted{margin-right:4px}
.sect{margin:0 0 14px}
.fsteps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:16px 0}
.fhead{display:flex;align-items:baseline;gap:8px}.fhead b{font-family:var(--disp);font-size:40px;letter-spacing:-.03em;line-height:1}.fhead span{font-size:15px}
.fbar{display:block;width:100%;height:10px;margin:8px 0 6px}.fbar rect{fill:var(--green)}.fbar rect.bg{fill:var(--chat)}
.fstep small{color:var(--mute);font-size:13px}
.fbreaks{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;border-top:1px solid var(--line);padding-top:14px}
.fbreak h4{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}
.frow{display:grid;grid-template-columns:minmax(0,2fr) repeat(4,minmax(0,1fr));gap:6px;font-size:14px;padding:4px 0;border-bottom:1px solid var(--line)}
.frow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.frow span:not(:first-child){text-align:right}.frow.fh{color:var(--mute);font-size:12px}
.bits{margin-top:14px;font-size:14px;overflow-wrap:anywhere}.bits code{font-size:13px}.slim{padding:14px 18px}.slim h3{font-size:18px}.slim .who>.muted{font-size:14px}.slim .bits{margin-top:6px}
`;
// Buttons post with fetch (the browser re-sends the Basic credentials) and show the answer inline.
const ADMIN_JS = `
for(const form of document.querySelectorAll('form[data-op]'))form.addEventListener('submit',async(e)=>{e.preventDefault();
  if(form.dataset.confirm&&!confirm(form.dataset.confirm))return;
  const out=form.closest('.acct').querySelector('.adout'),u=new URL(form.getAttribute('action'),location.origin);for(const [k,v] of new FormData(form))u.searchParams.set(k,v);
  out.textContent='…';try{const r=await fetch(u,{method:'POST'});const j=await r.json().catch(()=>({}));out.textContent=(r.ok?'✓ ':'✗ ')+JSON.stringify(j);if(r.ok&&form.dataset.reload)setTimeout(()=>location.reload(),900);}catch(err){out.textContent='✗ '+err.message;}});
`;
// Minutes and dollars per account. Metered exactly since `totals.since`; before that only the
// daily minutes exist, priced at the server's measured rate (or the speech price alone).
const usd = (v) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
function spend(t, rate) {
  const tot = t.totals || {};
  const ownMin = (tot.ownSeconds || 0) / 60, othersMin = (tot.othersSeconds || 0) / 60;
  const sinceDay = tot.since ? new Date(tot.since).toISOString().slice(0, 10) : '9999';
  const earlierMin = (t.usageHistory || []).filter((h) => h.day < sinceDay).reduce((a, h) => a + h.minutes, 0);
  const earlierUsd = earlierMin * (rate || speechPerMinute(t.model));
  return { ownMin, othersMin, meteredMin: ownMin + othersMin, usd: tot.usd || 0, unpriced: !!tot.unpriced, earlierMin, earlierUsd };
}
// Where a sign-up came from, as short pieces: country, device, address, source, and whether the browser was here before.
function signupBits(t, byId) {
  const u = t.signup; if (!u) return [];
  const c = u.country;
  const other = u.hadAccount && u.hadAccount !== t.id ? byId.get(u.hadAccount) : null;
  return [
    c ? `${flag(c.code)} ${esc(countryName(c.code))}${c.how === 'network' ? '' : ' <span class="muted">(browser language)</span>'}` : '',
    u.tz ? `<span class="muted">${esc(u.tz.replace(/_/g, ' '))}</span>` : '',
    esc(u.device || ''),
    u.ip ? `<code>${esc(u.ip)}</code>` : '',
    u.from ? `from ${esc(u.from)}` : u.invited ? 'from an invite' : 'direct',
    u.visitor ? (u.visits > 1 ? `returning browser: ${u.visits - 1} earlier visit${u.visits === 2 ? '' : 's'}, first ${ago(u.firstSeen)}` : 'first visit') : 'no visitor cookie',
    u.earlierAccounts ? `<span class="danger">${u.earlierAccounts} earlier sign-up${u.earlierAccounts === 1 ? '' : 's'} from this browser</span>` : '',
    other ? `browser already had <a href="/admin/a/${esc(other.id)}">${esc(other.waName || other.id.slice(0, 8))}</a>` : u.hadAccount && u.hadAccount !== t.id ? 'browser already had an account' : '',
  ].filter(Boolean);
}
// An account that never linked: one line, and when it will be removed.
function pendingCard(t, byId, more = []) {
  const left = Math.max(0, Math.round((t.expiresAt - Date.now()) / 60e3));
  const find = [t.id, t.signup?.ip, t.signup?.device, t.signup?.from, t.signup?.country && countryName(t.signup.country.code)].filter(Boolean).join(' ').toLowerCase().replace(/[\s+()-]/g, '');
  return `<article class="acct slim" data-state="wait" data-find="${esc(find)}" id="a-${esc(t.id)}">
<div class="who"><h3>Waiting to link${more.length ? ` <span class="muted">×${more.length + 1} sign-ups, same browser</span>` : ''}</h3><code>${esc([t, ...more].map((x) => x.id.slice(0, 8)).join(', '))}</code><span class="muted">signed up ${when(t.createdAt)} · ${t.mode === 'qr' ? 'code or QR on screen' : esc(t.mode)} · removed in ${left} min unless they link</span><span class="dot wait">Waiting</span></div>
${t.signup ? `<p class="bits">${signupBits(t, byId).join(' · ')}</p>` : ''}
</article>`;
}
// The owner's last commands in the Ramble group, newest first: the word, what came of it, and whether our reply went out.
const CMD_BAD = /no chat|could not|failed|nothing was waiting|not a command|not an option|no contact|unchanged/;
function commandList(cmds = []) {
  if (!cmds.length) return '';
  const row = (c) => `<li><span class="muted">${when(c.at)}</span> <b>${esc(c.cmd)}</b> <span${CMD_BAD.test(c.outcome) ? ' class="danger"' : ''}>${esc(c.outcome)}</span>${c.replied === false ? ' <span class="danger">· reply not delivered</span>' : ''}</li>`;
  return `<details class="cmds"${Date.now() - cmds[0].at < 864e5 ? ' open' : ''}><summary>Recent commands <span class="muted">(${cmds.length}, last ${ago(cmds[0].at)})</span></summary><ul>${cmds.map(row).join('')}</ul></details>`;
}
function adminCard(t, byCode, rate, byId) {
  if (!t.linkedAt) return pendingCard(t, byId);
  const [state, stateLabel] = stateOf(t);
  const $ = spend(t, rate);
  const name = t.waName || t.label || (t.linkedAt ? 'No name' : 'Not linked yet');
  const inviter = t.referredBy ? byCode.get(t.referredBy) : null;
  const find = [t.waName, t.label, t.phone, t.id, t.controlGroup].filter(Boolean).join(' ').toLowerCase().replace(/[\s+()-]/g, '');
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const langNow = t.language === 'auto' ? '' : t.language;
  return `<article class="acct" data-state="${state}" data-find="${esc(find)}" id="a-${esc(t.id)}">
<div class="who"><h3>${esc(name)}</h3>${t.phone ? `<a href="https://wa.me/${esc(t.phone)}" rel="noopener" target="_blank">${esc(phoneText(t.phone))}</a>` : ''}<code>${esc(t.id.slice(0, 8))}</code><span class="dot ${state}">${esc(stateLabel)}</span></div>
<p class="when">Signed up ${when(t.createdAt)} · linked ${when(t.linkedAt)} · last voice note ${when(t.lastMessageAt)}</p>
<div class="facts2">
<div><small>Audio today</small><p><b>${t.minutesToday}</b>${t.dailyMinutes ? ` / ${t.dailyMinutes}` : ''} min${t.bonusMinutes ? ` <span class="muted">(+${t.bonusMinutes} bonus)</span>` : ''}</p></div>
<div><small>Transcribed</small><p><b>${(t.totals?.own || 0) + (t.totals?.others || 0)}</b> recordings<br><span class="muted">${t.totals?.own || 0} theirs · ${t.totals?.others || 0} from others${t.totals?.since ? ` · since ${new Date(t.totals.since).toISOString().slice(0, 10)}` : ''}</span></p></div>
<div><small>Minutes transcribed</small><p><b>${Math.round($.meteredMin + $.earlierMin)}</b> min<br><span class="muted">${Math.round($.ownMin)} theirs · ${Math.round($.othersMin)} from others${$.earlierMin ? ` · ${$.earlierMin} before counting` : ''}</span></p></div>
<div><small>Cost</small><p><b>${usd($.usd + $.earlierUsd)}</b>${$.earlierUsd || $.unpriced ? ' <span class="muted">(estimate)</span>' : ''}<br><span class="muted">${$.meteredMin >= 1 ? `${usd($.usd / $.meteredMin)}/min` : ''}${$.earlierUsd ? `${$.meteredMin >= 1 ? ' · ' : ''}~${usd($.earlierUsd)} before counting` : ''}</span></p></div>
<div><small>Usage</small>${usageBars(t.usageHistory, t.minutesToday)}</div>
<div><small>Since restart</small><p>${t.stats.transcribed} done · ${t.stats.dropped} skipped · <span${t.stats.failed ? ' class="danger"' : ''}>${t.stats.failed} failed</span></p></div>
<div><small>Chats</small><p>${t.enabledGroups} groups on · ${t.mutedChats} chats off</p></div>
<div><small>Plan · language</small><p>${esc(t.plan)} · ${esc(t.model)}<br><span class="muted">${esc(t.language)}${t.abModel ? ` · A/B ${esc(t.abModel)}` : ''}${t.keepAudio ? ' · 🎧 keeping audio' : ''}${t.transcribeVideo ? ' · 🎬 videos' : ''}${t.voiceFix ? ' · ✏️ voice fixes' : ''}</span></p></div>
<div><small>Control group</small><p>${t.controlGroup ? esc(t.controlGroup) : `<span class="danger">none</span>`}${t.needsManualGroup ? ' <span class="muted">(needs manual)</span>' : ''}</p></div>
<div><small>Invites</small><p>${t.invited} friend${t.invited === 1 ? '' : 's'} joined${inviter ? `<br><span class="muted">invited by <a href="/admin/a/${esc(inviter.id)}">${esc(inviter.waName || inviter.label || inviter.id.slice(0, 8))}</a></span>` : ''}</p></div>
</div>
${t.signup ? `<p class="bits"><b>Signed up from</b> ${signupBits(t, byId).join(' · ')}</p>` : ''}
${commandList(t.commands)}
${t.lastError ? `<div class="err"><b>Last error</b> ${when(t.lastError.at)}: ${esc(t.lastError.message)}</div>` : ''}
<details><summary>Support tools</summary><div class="ops">
<form data-op action="/admin/plan/${esc(t.id)}" data-reload="1"><div class="f"><label>Plan</label><select name="plan">${PLANS.map((p) => opt(p, `${p} · ${planLabel(p)}`, t.plan)).join('')}</select></div><button class="btn">Set</button></form>
<form data-op action="/admin/language/${esc(t.id)}" data-reload="1"><div class="f"><label>Language</label><select name="code">${LANGUAGES.map(([v, , en]) => opt(v, en, langNow)).join('')}</select></div><button class="btn">Set</button></form>
<form data-op action="/admin/cap/${esc(t.id)}" data-reload="1"><div class="f"><label>Daily limit, minutes (empty = default)</label><input type="text" name="minutes" inputmode="numeric" value="${t.capMinutes ? esc(t.capMinutes) : ''}" placeholder="${DAILY_MINUTES_CAP || 'no limit'}"></div><button class="btn">Set</button></form>
<form data-op action="/admin/ab/${esc(t.id)}" data-reload="1"><div class="f"><label>A/B models (comma-separated, empty = off)</label><input type="text" name="model" value="${esc(t.abModel || '')}"></div><button class="btn">Set</button></form>
<form data-op action="/admin/keep-audio/${esc(t.id)}" data-reload="1"><input type="hidden" name="on" value="${t.keepAudio ? '0' : '1'}"><div class="f"><label>Keep recordings for research</label><p class="muted">${t.keepAudio ? 'On' : 'Off'}</p></div><button class="btn">${t.keepAudio ? 'Turn off' : 'Turn on'}</button></form>
<form data-op action="/admin/video/${esc(t.id)}" data-reload="1"><input type="hidden" name="on" value="${t.transcribeVideo ? '0' : '1'}"><div class="f"><label>Transcribe videos</label><p class="muted">${t.transcribeVideo ? 'On' : 'Off (voice notes only)'}</p></div><button class="btn">${t.transcribeVideo ? 'Turn off' : 'Turn on'}</button></form>
<form data-op action="/admin/voice-fix/${esc(t.id)}" data-reload="1"><input type="hidden" name="on" value="${t.voiceFix ? '0' : '1'}"><div class="f"><label>Corrections by voice (pilot)</label><p class="muted">${t.voiceFix ? 'On: a spoken reply to a transcript fixes it' : 'Off'}</p></div><button class="btn">${t.voiceFix ? 'Turn off' : 'Turn on'}</button></form>
<form data-op action="/admin/link/${esc(t.id)}" data-confirm="Issue a new private link? The old one stops working."><div class="f"><label>Private link</label><p class="muted">Owner lost it?</p></div><button class="btn">New link</button></form>
<form data-op action="/admin/control-group/${esc(t.id)}" data-confirm="Create a new control group in this account's WhatsApp?" data-reload="1"><input type="hidden" name="force" value="1"><div class="f"><label>Control group</label><p class="muted">Deleted by the owner?</p></div><button class="btn">Recreate</button></form>
</div><p class="adout"></p></details>
</article>`;
}
// The funnel: people (one per browser) who first came in the period, how many clicked
// "Link my WhatsApp", and how many finished linking. Crawlers, link previews and the
// operator's own browser are left out; see visitors.js.
const FUNNEL_PERIODS = [[1, 'Last 24h'], [7, '7 days'], [30, '30 days'], [0, 'All time']];
const deviceKind = (d = '') => { const os = d.split(' · ')[0]; return ['iPhone', 'iPad', 'Android', 'Mac', 'Windows', 'Linux', 'ChromeOS'].includes(os) ? os : 'Other'; };
function funnel(days, tenants) {
  const start = days ? Date.now() - days * 864e5 : 0;
  const linkedIds = new Set(tenants.filter((t) => t.linkedAt).map((t) => t.id));
  const people = visitors.list().map(([, v]) => v).filter((v) => !v.staff && (v.human || v.accounts.length));
  const since = people.filter((v) => v.human).reduce((m, v) => Math.min(m, v.first), Infinity);
  const steps = (vs) => {
    const clicked = vs.filter((v) => v.accounts.length);
    return { came: vs.length, clicked: clicked.length, linked: clicked.filter((v) => v.linkedAt || v.accounts.some((a) => linkedIds.has(a))).length };
  };
  const cohort = people.filter((v) => v.first >= start);
  const by = (key) => [...cohort.reduce((m, v) => m.set(key(v), [...(m.get(key(v)) || []), v]), new Map())].map(([k, vs]) => [k, steps(vs)]).sort((a, b) => b[1].came - a[1].came);
  return { ...steps(cohort), since: Number.isFinite(since) ? since : null, bySource: by((v) => v.from || 'direct'), byDevice: by((v) => deviceKind(v.device)) };
}
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const bar = (n, max) => `<svg class="fbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="10" rx="2" class="bg"/><rect width="${max ? Math.max(n ? 1 : 0, (n / max) * 100).toFixed(1) : 0}" height="10" rx="2"/></svg>`;
function funnelPanel(f, days, sort = 'recent') {
  const step = (label, n, note) => `<div class="fstep"><div class="fhead"><b>${n}</b><span>${label}</span></div>${bar(n, f.came)}<small>${note}</small></div>`;
  const rows = (title, list) => list.length ? `<div class="fbreak"><h4>${title}</h4><div class="frow fh"><span></span><span>came</span><span>clicked</span><span>linked</span><span>overall</span></div>${list.map(([k, x]) => `<div class="frow"><span>${esc(k)}</span><span>${x.came}</span><span>${x.clicked}</span><span>${x.linked}</span><span>${pct(x.linked, x.came)}</span></div>`).join('')}</div>` : '';
  return `<section class="funnel"><div class="fttl"><h2>Funnel</h2><nav>${FUNNEL_PERIODS.map(([d, l]) => `<a class="chip" aria-pressed="${d === days}" href="/admin?days=${d}&sort=${sort}">${l}</a>`).join('')}</nav></div>
<p class="muted">People who first came ${days ? `in the ${days === 1 ? 'last 24 hours' : `last ${days} days`}` : 'ever'}, one per browser. Crawlers, link previews and your own browser are left out.${f.since ? ` Counting since ${new Date(f.since).toISOString().slice(0, 10)}.` : ' Counting starts with the next visit.'}</p>
<div class="fsteps">
${step('came to the site', f.came, 'one per browser')}
${step('clicked “Link my WhatsApp”', f.clicked, `${pct(f.clicked, f.came)} of those who came · ${f.came - f.clicked} left without clicking`)}
${step('linked WhatsApp', f.linked, `${pct(f.linked, f.clicked)} of those who clicked · ${f.clicked - f.linked} stopped at the QR / code`)}
</div>
<div class="fbreaks">${rows('By source', f.bySource)}${rows('By device', f.byDevice)}</div>
</section>`;
}
// The account list's order: recent activity (the default), or minutes transcribed today, in the
// last 7 days (today included), or all time: the heavy users first.
const ACCOUNT_SORTS = [['recent', 'Recent'], ['today', 'Today'], ['week', '7 days'], ['total', 'All time']];
function minutesFor(t, sort, rate) {
  if (sort === 'today') return t.minutesToday || 0;
  if (sort === 'week') {
    const days = new Set(Array.from({ length: 6 }, (_, i) => new Date(Date.now() - (i + 1) * 864e5).toISOString().slice(0, 10)));
    return (t.minutesToday || 0) + (t.usageHistory || []).filter((h) => days.has(h.day)).reduce((a, h) => a + h.minutes, 0);
  }
  const $ = spend(t, rate);
  return $.meteredMin + $.earlierMin;
}
// What owners wrote on the settings page, newest first; the ones since the operator last looked are marked new.
function feedbackPanel(items, seenAt) {
  if (!items.length) return '';
  const fresh = items.filter((f) => f.at > seenAt).length;
  return `<h2 class="sect" id="feedback">Feedback${fresh ? ` <span class="danger">${fresh} new</span>` : ''}</h2><div class="fbl">${items.slice(0, 30).map((f) => `<article class="fbi${f.at > seenAt ? ' new' : ''}"><p class="when">${esc(f.name || 'No name')}${f.phone ? ` · ${esc(phoneText(f.phone))}` : ''} · <a href="/admin/a/${esc(f.account)}">${esc(f.account.slice(0, 6))}</a> · ${when(f.at)}</p><p>${esc(f.text)}</p></article>`).join('')}</div>`;
}
// The server's measured dollars per minute of audio, once there are five minutes to measure.
function measuredRate(ts) {
  const [usdSum, min] = ts.reduce((a, t) => [a[0] + (t.totals?.usd || 0), a[1] + ((t.totals?.ownSeconds || 0) + (t.totals?.othersSeconds || 0)) / 60], [0, 0]);
  return min >= 5 ? usdSum / min : 0;
}
function adminPage(o, nonce, { days = 30, sort = 'recent', q = '', f = 'all', page = 1 } = {}) {
  const byCode = new Map(o.tenants.map((t) => [t.inviteCode, t]));
  const byId = new Map(o.tenants.map((t) => [t.id, t]));
  const rank = (t) => (t.ready ? 0 : t.linkedAt ? 1 : 2);
  const ts = [...o.tenants].sort((a, b) => rank(a) - rank(b) || (b.lastMessageAt || b.linkedAt || b.createdAt) - (a.lastMessageAt || a.linkedAt || a.createdAt));
  const errors = ts.filter((t) => stateOf(t)[0] === 'warn' || stateOf(t)[0] === 'bad').length;
  // The server's measured dollars per minute, once there is enough to measure; it prices the minutes from before the meter.
  const rate = measuredRate(ts);
  if (sort !== 'recent') {
    // Heaviest first; accounts that never linked stay at the end.
    const m = new Map(ts.map((t) => [t.id, minutesFor(t, sort, rate)]));
    ts.sort((a, b) => (!a.linkedAt) - (!b.linkedAt) || m.get(b.id) - m.get(a.id));
  }
  const all = ts.map((t) => spend(t, rate));
  const allMin = all.reduce((a, x) => a + x.meteredMin + x.earlierMin, 0), allUsd = all.reduce((a, x) => a + x.usd + x.earlierUsd, 0);
  const h = o.health, d = h.disk, away = h.turnedAway.full + h.turnedAway.waiting + h.turnedAway.rate + (h.turnedAway.stall || 0);
  // A figure turns red from 80% of its ceiling: that is when there is still time to do something.
  const warnAt = (text, share) => (share >= 0.8 ? `<span class="danger">${text}</span>` : text);
  const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : compact(n));
  const ago = (at) => { const m = Math.round((Date.now() - at) / 60e3); return m < 1 ? 'just now' : m < 120 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
  const tile = (label, big, small = '') => `<div class="tile"><small>${label}</small><b>${big}</b> <span>${small}</span></div>`;
  return `${nonceStyle(nonce, ADMIN_CSS)}<div class="wrap adm"><h1 class="small">Admin</h1>
<div class="tiles">
${tile('Connected', o.connected, `of ${o.accounts} · cap ${o.max}`)}
${tile('Transcribed', ts.reduce((n, t) => n + (t.totals?.own || 0) + (t.totals?.others || 0), 0), 'recordings, all accounts')}
${tile('Minutes', Math.round(allMin), 'transcribed, all accounts')}
${tile('Cost', usd(allUsd), rate ? `${usd(rate)}/min measured` : 'estimate')}
${tile('Waiting to link', warnAt(o.pending, o.pending / (o.maxPending || Infinity)), `of ${o.maxPending} at once`)}
${tile('Sign-ups', h.admission.open ? 'open' : '<span class="danger">paused</span>', h.admission.open ? `longest stall in the last minute ${(h.admission.stallMs / 1000).toFixed(1)}s` : ({ deploy: 'for a deploy', starting: 'accounts reconnecting after a start' }[h.admission.why] || `stood still ${(h.admission.stallMs / 1000).toFixed(1)}s in the last minute`))}
${tile('Need attention', errors)}
${tile('Audio today', o.budget.serverMinutesToday, `${o.budget.serverDailyMinutes ? `/ ${o.budget.serverDailyMinutes} ` : ''}min${o.budget.perAccountDailyMinutes ? ` · ${o.budget.perAccountDailyMinutes}/account` : ''}`)}
</div>
<h2 class="sect">Server</h2>
<div class="tiles">
${tile('Accounts', warnAt(`${Math.round((o.accounts / o.max) * 100)}%`, o.accounts / o.max), `${o.accounts} of ${o.max}`)}
${tile('Files on disk', d?.filesPct == null ? '—' : warnAt(`${d.filesPct}%`, d.filesPct / 100), d?.filesPct == null ? 'not reported here' : `${count(d.filesUsed)} used · ${count(d.filesFree)} free`)}
${tile('Disk space', o.dataMounted === false ? '<span class="danger">NOT MOUNTED</span>' : d?.spacePct == null ? 'OK' : warnAt(`${d.spacePct}%`, d.spacePct / 100), d ? `${d.freeMb >= 1000 ? `${(d.freeMb / 1000).toFixed(1)} GB` : `${d.freeMb} MB`} free` : 'data volume')}
${tile('Failed writes', h.diskFailures.failures ? `<span class="danger">${h.diskFailures.failures}</span>` : 0, h.diskFailures.failures ? `last ${esc(h.diskFailures.lastCode)} · ${ago(h.diskFailures.lastAt)}` : 'since restart')}
${tile('Turned away', away ? `<span class="danger">${away}</span>` : 0, away ? `${h.turnedAway.full} full · ${h.turnedAway.waiting} queue · ${h.turnedAway.stall || 0} load · ${h.turnedAway.rate} rate limit` : 'sign-ups, since restart')}
${tile('Memory', h.memoryMb >= 1000 ? `${(h.memoryMb / 1000).toFixed(1)} GB` : `${h.memoryMb} MB`, `heap ${count(h.memory.heapUsedMb)} · buffers ${count(h.memory.buffersMb)} MB`)}
${tile('Up', h.uptimeMinutes < 120 ? `${h.uptimeMinutes}m` : `${Math.round(h.uptimeMinutes / 60)}h`, 'since restart')}
</div>
${feedbackPanel(o.feedback, o.feedbackSeenAt)}
${o.notesHtml || ''}
${funnelPanel(funnel(days, o.tenants), days, sort)}
<h2 class="sect">Accounts</h2>
${accountList(ts, { q, f, sort, page, days, rate })}
</div>`;
}

// The account list: one short row per account, 50 a page, searched and filtered on the server, so
// the page stays light with any number of accounts. A row opens the account's own page (/admin/a/<id>).
const PER_PAGE = 50;
const ACCOUNT_FILTERS = [['all', 'All'], ['ok', 'Connected'], ['bad', 'Need attention'], ['wait', 'Waiting']];
const norm = (v) => String(v || '').toLowerCase().replace(/[\s+()-]/g, '');
function accountList(ts, { q = '', f = 'all', sort = 'recent', page = 1, days = 30, rate = 0 }) {
  // Waiting sign-ups from one browser are one person: one row for all of them.
  const seen = new Map();
  const rows = [];
  for (const t of ts) {
    const v = !t.linkedAt && t.signup?.visitor;
    if (v && seen.has(v)) { seen.get(v).more++; continue; }
    const r = { t, more: 0 }; if (v) seen.set(v, r); rows.push(r);
  }
  const needle = norm(q);
  const hits = rows.filter(({ t }) => {
    const st = stateOf(t)[0];
    if (f === 'ok' && st !== 'ok') return false;
    if (f === 'bad' && st !== 'warn' && st !== 'bad') return false;
    if (f === 'wait' && st !== 'wait') return false;
    // Each field on its own: a search never matches across the seam between a name and the id after it.
    return !needle || [t.waName, t.label, t.phone, t.id, t.controlGroup, t.signup?.ip].filter(Boolean).map(norm).join(' ').includes(needle);
  });
  const pages = Math.max(1, Math.ceil(hits.length / PER_PAGE)), p = Math.min(Math.max(1, page), pages);
  const link = (o) => `/admin?${new URLSearchParams({ days, sort, f, ...(q ? { q } : {}), ...o })}#accounts`;
  const row = ({ t, more }) => {
    const [state, label] = stateOf(t);
    if (!t.linkedAt) {
      const left = Math.max(0, Math.round((t.expiresAt - Date.now()) / 60e3));
      return `<a class="arow" href="/admin/a/${esc(t.id)}"><span class="dot ${state}" title="${esc(label)}"></span><span class="an">Waiting to link${more ? ` <span class="muted">×${more + 1}</span>` : ''}</span><span class="muted">${esc([t.signup?.device, t.signup?.country && countryName(t.signup.country.code)].filter(Boolean).join(' · '))}</span><span class="muted">signed up ${ago(t.createdAt)} · removed in ${left} min</span></a>`;
    }
    const $ = spend(t, rate), recs = (t.totals?.own || 0) + (t.totals?.others || 0);
    const fresh = t.commands?.[0] && Date.now() - t.commands[0].at < 864e5 && CMD_BAD.test(t.commands[0].outcome);
    return `<a class="arow" href="/admin/a/${esc(t.id)}"><span class="dot ${state}" title="${esc(label)}"></span><span class="an"><b>${esc(t.waName || t.label || 'No name')}</b>${t.phone ? ` <span class="muted">${esc(phoneText(t.phone))}</span>` : ''}</span><span>${sort === 'recent' ? `last note ${ago(t.lastMessageAt)}` : `${Math.round(minutesFor(t, sort, rate))} min`}</span><span class="muted">${t.minutesToday} min today · ${recs} rec · ${usd($.usd + $.earlierUsd)}${t.lastError ? ' · <span class="danger">error</span>' : ''}${fresh ? ' · <span class="danger">command failed</span>' : ''}</span></a>`;
  };
  return `<h2 class="sect" id="accounts">Accounts</h2>
<form class="adbar" method="get" action="/admin#accounts"><input type="hidden" name="days" value="${days}"><input type="hidden" name="sort" value="${esc(sort)}"><input type="hidden" name="f" value="${esc(f)}">
<input type="text" id="q" name="q" value="${esc(q)}" placeholder="Search name, number, id, group, IP" autocomplete="off"><button class="chip" type="submit">Search</button></form>
<nav class="sorts">${ACCOUNT_FILTERS.map(([k, l]) => `<a class="chip" aria-pressed="${k === f}" href="${link({ f: k, page: 1 })}">${l}</a>`).join('')}<span class="muted">· Sort</span>${ACCOUNT_SORTS.map(([k, l]) => `<a class="chip" aria-pressed="${k === sort}" href="${link({ sort: k, page: 1 })}">${l}</a>`).join('')}</nav>
<p class="muted">${hits.length ? `${(p - 1) * PER_PAGE + 1}–${Math.min(p * PER_PAGE, hits.length)} of ${hits.length}` : 'No account matches.'}${sort === 'recent' ? '' : ' · minutes transcribed'}</p>
<div class="alist">${hits.slice((p - 1) * PER_PAGE, p * PER_PAGE).map(row).join('')}</div>
${pages > 1 ? `<nav class="pager">${p > 1 ? `<a class="chip" href="${link({ page: p - 1 })}">← Previous</a>` : ''}<span class="muted">Page ${p} of ${pages}</span>${p < pages ? `<a class="chip" href="${link({ page: p + 1 })}">Next →</a>` : ''}</nav>` : ''}`;
}

export function createWebApp() {
  const app = express();
  app.disable('x-powered-by');
  // Which proxy hops to trust for the client IP. Railway/most PaaS: 1 hop. Direct exposure: 0.
  const tp = process.env.TRUST_PROXY ?? '1';
  app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : /^\d+$/.test(tp) ? Number(tp) : tp);
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));

  // A retired domain forwards to the current one (health checks excepted, so the old name can still be probed).
  app.use((req, res, next) => {
    if (!CANONICAL_HOST || req.path === '/healthz' || !LEGACY_HOSTS.has(String(req.hostname || '').toLowerCase())) return next();
    // A form posted from a page still open (or cached) on the old domain cannot be forwarded as a
    // POST: the browser would re-send it cross-site and the check below would refuse it. It lands
    // on the new home page instead, one click from where it was.
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.redirect(303, `https://${CANONICAL_HOST}/`);
    res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  });
  // Security headers on every response; private pages are never cached.
  app.use((req, res, next) => {
    res.locals.nonce = randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${res.locals.nonce}'; style-src 'nonce-${res.locals.nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      // same-origin, not no-referrer: nothing leaves the site either way, but under no-referrer a
      // browser sends our own forms with "Origin: null", which the cross-site check cannot tell from an attack.
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (/^\/(link|api|admin|unlink|settings)/.test(req.path)) res.set('Cache-Control', 'no-store');
    res.locals.lang = siteLang(req);
    res.set('Vary', 'Accept-Language, Cookie');
    // The footer's language link: remember the choice, then show the same page without the query.
    if (req.method === 'GET' && SITE_LANGS.has(req.query.lang)) {
      res.append('Set-Cookie', `lang=${req.query.lang}; Path=/; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
      return res.redirect(303, req.path);
    }
    next();
  });
  // Cross-site POSTs are refused: a browser always sends Origin (or Sec-Fetch-Site) on them.
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin'), site = req.get('sec-fetch-site');
    const refuse = () => {
      console.warn(`🛑 cross-site POST refused: ${req.path.replace(/[0-9a-f]{32}/g, ':id')} (origin ${!origin ? 'none' : origin === 'null' ? 'null' : 'another site'}, sec-fetch-site ${site || 'none'}, ${deviceOf(String(req.get('user-agent') || '')) || 'unknown device'})`);
      return res.status(403).type('text').send('Cross-site request refused');
    };
    // "Origin: null" is what a browser sends when it withholds the origin (a page still cached with
    // the old no-referrer policy, a privacy mode): then Sec-Fetch-Site, which a page cannot forge, decides.
    if (origin && origin !== 'null') {
      let ok = false;
      try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; }
      if (!ok) return refuse();
    } else if (origin === 'null' ? site !== 'same-origin' : site === 'cross-site') return refuse();
    next();
  });

  // The share picture and the icons, as files: link previews and home screens cannot read the inline SVG.
  const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url));
  for (const [route, file] of [['/og.png', 'og.png'], ['/icon-180.png', 'icon-180.png'], ['/icon-512.png', 'icon-512.png'], ['/favicon-32.png', 'favicon-32.png'], ['/favicon.ico', 'favicon-32.png'], ['/apple-touch-icon.png', 'icon-180.png']]) {
    app.get(route, (_req, res) => { res.set('Cache-Control', 'public, max-age=86400'); res.type('image/png').sendFile(join(ASSET_DIR, file)); });
  }

  app.get('/fonts/:file', (req, res) => {
    if (!FONT_FILES.has(req.params.file)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('font/woff2').sendFile(join(FONT_DIR, req.params.file));
  });

  // ---------- returning browsers ----------
  // Public pages give a browser an anonymous id (a random cookie) and count its visits; see visitors.js.
  // Crawlers and link previews get none: they are not people, and would each look like a new one.
  const track = (req, res) => {
    const ua = String(req.get('user-agent') || '');
    if (!ua || BOT_RE.test(ua)) return;
    let id = cookies(req).rv;
    if (!visitors.VISITOR_RE.test(id || '')) { id = visitors.newVisitorId(); res.append('Set-Cookie', `rv=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`); }
    let from = sourceHost(req.get('referer'));
    if (from === String(req.hostname || '').replace(/^www\./, '')) from = '';
    visitors.visit(id, { device: deviceOf(ua), from: from || (req.path.startsWith('/i/') ? 'invite' : '') });
  };
  // The landing page's script reports back: a browser that runs scripts is a person, not a crawler.
  app.post('/hi', (req, res) => { const id = cookies(req).rv; if (visitors.VISITOR_RE.test(id || '')) visitors.confirm(id); res.status(204).end(); });
  // The landing form also says which site sent the visitor and the browser's time zone.
  const LANDING_JS = `fetch('/hi',{method:'POST'}).catch(()=>{});for(const f of document.querySelectorAll('form[action="/start"]')){const set=(n,v)=>{const i=f.querySelector('[name='+n+']');if(i)i.value=v||'';};
try{set('tz',Intl.DateTimeFormat().resolvedOptions().timeZone);}catch{}
try{const r=document.referrer&&new URL(document.referrer);if(r&&r.host!==location.host)set('from',r.origin);}catch{}}`;

  // ---------- landing ----------
  const STAR_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>';
  const CODE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/></svg>';
  const NAV = '<a class="navlink" href="/how">How it works</a>';
  const FOOT = `<footer class="foot wrap"><p>${esc(PRODUCT_NAME)} is not made by WhatsApp. It&#39;s an unofficial client, so <a href="/privacy">read the risks</a> first.</p><nav><a href="/how">How it works</a><a href="/privacy">Privacy &amp; terms</a><a href="${esc(REPO_URL)}">Open source</a></nav></footer>`;
  // The closing button signs up right there, like the one at the top (behind an invite code it can only lead up to it).
  const closeCta = (label, fine) => (INVITE_CODE ? `<a class="cta" href="/#start">${label}</a>`
    : `<form method="post" action="/start" class="start"><input type="hidden" name="consent" value="1"><input type="hidden" name="tz"><input type="hidden" name="from"><button type="submit" class="cta">${label}</button><p class="fine">${fine}</p></form>`);
  // The same fragments in the page's language. English pages offer Hebrew only to a browser that has it.
  const isHe = (res) => res.locals.lang === 'he';
  const navFor = (res) => (isHe(res) ? `<a class="navlink" href="/how">${HE.nav}</a>` : NAV);
  const closeFor = (res) => (isHe(res)
    ? `<section class="close"><div class="wrap"><h2>${HE.close.h}</h2>${closeCta(HE.close.cta, 'ההמשך מהווה הסכמה ל<a href="/privacy">פרטיות ולתנאים</a>.')}</div></section>`
    : `<section class="close"><div class="wrap"><h2>Go on. Ramble.</h2>${closeCta('Link my WhatsApp', 'By continuing you agree to the <a href="/privacy">privacy &amp; terms</a>.')}</div></section>`);
  const footFor = (req, res) => {
    const other = isHe(res) ? '<a href="?lang=en" lang="en">English</a>' : knowsHebrew(req) ? '<a href="?lang=he" lang="he" dir="rtl">עברית</a>' : '';
    if (!isHe(res)) return other ? FOOT.replace('</nav></footer>', `${other}</nav></footer>`) : FOOT;
    const n = HE.footNav;
    return `<footer class="foot wrap"><p>${HE.foot(esc(PRODUCT_NAME))}</p><nav><a href="/how">${n.how}</a><a href="/privacy">${n.privacy}</a><a href="${esc(REPO_URL)}">${n.oss}</a>${other}</nav></footer>`;
  };
  /** A small page in the page's language: [title, text] pairs for each. */
  const small = (res, en, he, extra = '') => { const [t, p] = isHe(res) ? he : en; return page(res, t, `<h1 class="small">${t}</h1><p>${p}</p>${extra}`); };
  const landing = (req, res, invitedBy = null) => {
    track(req, res);
    refreshStars();
    if (isHe(res)) return res.type('html').send(page(res, PRODUCT_NAME, landingHe({ esc, NAME: esc(PRODUCT_NAME), WAVE_SVG, INVITE_CODE, invitedBy, REPO_URL, CODE_SVG, ghExtra: stars == null ? '' : `<span>${STAR_SVG}${compact(stars)}</span>`, close: closeFor(res), foot: footFor(req, res) }), { wide: true, nav: navFor(res), poll: LANDING_JS }));
    res.type('html').send(page(res, PRODUCT_NAME, `
<section class="hero wrap">
${invitedBy ? '<span class="invited">A friend invited you.</span>' : ''}
<h1>Ramble, baby.<br><span>It&#39;s handled.</span></h1>
<p class="sub">Every voice note, as text you can read at a glance. Right under the recording.</p>
<form method="post" action="/start" id="start" class="start">
${INVITE_CODE ? '<div><label for="invite">Invite code</label><input type="text" id="invite" name="invite" autocomplete="off" required></div>' : ''}
<input type="hidden" name="consent" value="1"><input type="hidden" name="tz"><input type="hidden" name="from">${invitedBy ? `<input type="hidden" name="ref" value="${esc(invitedBy)}">` : ''}
<button type="submit" class="cta">Link my WhatsApp</button>
<ul class="safe"><li><svg width="12" height="14" viewBox="0 0 15 17" aria-hidden="true"><rect x="1.5" y="7.5" width="12" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 7.5V5a3 3 0 0 1 6 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>Recordings and text are never saved.</li><li><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10 5l3 3-3 3M13 8H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Unlink anytime.</li></ul>
<p class="fine">By continuing you agree to the <a href="/privacy">privacy &amp; terms</a>.</p>
</form>
${DEMO}
</section>
<section class="band"><div class="wrap">
<div class="both">
<div class="lead"><h2>Works both ways.</h2><p>The voice notes you send get text for them. The ones they send get text for you.</p></div>
<div class="say"><span class="me">You ramble. They read.</span><span class="them">They ramble. You read.</span></div>
</div>
<div class="facts"><p><b>Any language.</b> It works out which one on its own.</p><p><b>Nothing kept.</b> A recording is deleted the moment it becomes text.</p></div>
</div></section>
<section class="band"><div class="wrap"><ol class="steps"><li>Link your WhatsApp.</li><li>Send a voice note.</li><li>The text shows up under it.</li></ol></div></section>
<section class="band"><div class="wrap oss">
<div><h2>Open source.</h2><p>Read every line, or run it on your own server.</p></div>
<a class="gh" href="${esc(REPO_URL)}"><span>${CODE_SVG}View on GitHub</span>${stars == null ? '' : `<span>${STAR_SVG}${compact(stars)}</span>`}</a>
</div></section>
${closeFor(res)}
${footFor(req, res)}`, { wide: true, nav: NAV, poll: LANDING_JS }));
  };

  app.get('/', (req, res) => landing(req, res, cookies(req).rref || null));
  // An invite link: the same landing page, remembering who sent it.
  app.get('/i/:code', (req, res) => {
    const code = String(req.params.code || '');
    if (!registry.byInvite(code)) return res.redirect(303, '/');
    res.append('Set-Cookie', `rref=${code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${req.secure ? '; Secure' : ''}`);
    landing(req, res, code);
  });

  // How it works: the setup, what happens on its own, and everything the control group can do,
  // each command shown as the WhatsApp exchange it really is.
  const voice = (dur, fwd = false, label = 'Forwarded') => `<div class="me vn">${fwd ? `<em>${label}</em>` : ''}<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M1 1.2v13.6L13 8z" fill="currentColor"/></svg>${WAVE_SVG}<span>${dur}</span></div>`;
  const mini = (where, bubbles) => `<div class="mini" role="img" aria-label="An example exchange in WhatsApp"><small>${where}</small>${bubbles}</div>`;
  const NAME = esc(PRODUCT_NAME);
  // A reply, the way WhatsApp draws one: the quoted message sits inside the bubble, above the answer.
  const quote = (who, text) => `<span class="q"><b>${who}</b>${text}</span>`;
  app.get('/how', (req, res) => track(req, res) ?? (isHe(res)
    ? res.type('html').send(page(res, `${PRODUCT_NAME} · ${HE.title.how}`, howHe({ NAME, mini, voice, quote, DAILY_MINUTES_CAP, close: closeFor(res), foot: footFor(req, res) }), { wide: true, nav: navFor(res) }))
    : res.type('html').send(page(res, `${PRODUCT_NAME} · How it works`, `
<section class="howhero wrap"><h1>How it works.</h1><p class="sub">Set it up once. After that, everything happens inside WhatsApp.</p></section>
<section class="band"><div class="wrap"><ol class="steps long">
<li><div>Link your WhatsApp.<span>Scan a QR code, or on your phone type in a code. In WhatsApp: Settings, Linked devices, Link a device. Same as WhatsApp Web.</span></div></li>
<li><div>Get your ${NAME} group.<span>A new group with only you in it. It&#39;s your control panel.</span></div></li>
<li><div>Record a voice note there.<span>Its text shows up right under it. That&#39;s the whole setup.</span></div></li>
</ol></div></section>
<section class="band"><div class="wrap"><h2>Then it runs itself.</h2>
<div class="facts plain">
<p><b>Your voice notes.</b> Every one you send gets its text right under it, in private chats and in groups.</p>
<p><b>Private chats.</b> Voice notes people send you get their text too.</p>
<p><b>Clean text.</b> Every word they said, with the ums gone and the misheard words fixed.</p>
<p><b>Hands off.</b> View-once media is never touched. In disappearing chats, the text disappears with the recording.</p>
<p><b>Any language.</b> It works out which one on its own.</p>
<p><b>Your call.</b> Write settings in your ${NAME} group to choose what gets transcribed, whose, and whether the text appears in the chat or only to you.</p>
${DAILY_MINUTES_CAP ? `<p><b>A daily limit.</b> ${DAILY_MINUTES_CAP} minutes of audio a day.</p>` : ''}
</div></div></section>
<section class="band"><div class="wrap"><h2>When you want more.</h2><p class="intro">You run ${NAME} by talking to it, in WhatsApp. Write help in your ${NAME} group for the full list.</p>
<div class="asks">
<div class="ask"><div><h3>Everyone in a group.</h3><p>In groups, only your own voice notes get their text, until you say otherwise. Write include and the group&#39;s name in your ${NAME} group, or forward one voice note from it and reply include, and every voice note there gets its text. Or choose for all your groups at once on the settings page. Nothing is ever posted in a group to control it.</p></div>
${mini(`${NAME} group`, `${voice('0:32', true)}<div class="bot"><b>Family</b>: only your own voice notes are transcribed. Reply <b>include</b> for everyone&#39;s.</div><div class="me">${quote(NAME, 'Family: only your own voice notes are transcribed.')}include</div><div class="bot">Transcribe <b>Family (group)</b>? Reply <b>yes</b> to include it.</div>`)}</div>
<div class="ask"><div><h3>Keep it private.</h3><p>Write private and a chat&#39;s name. Every recording in it, yours included, is transcribed into your ${NAME} group only. Nothing is posted in the chat.</p></div>
${mini(`${NAME} group`, `<div class="me">private Book club</div><div class="bot">Transcribe <b>Book club (group)</b> privately? Reply <b>yes</b> to switch.</div><div class="me">yes</div><div class="bot"><b>Dana</b> in <b>Book club</b><br>I&#39;ll be there in twenty minutes, start without me.</div>`)}</div>
<div class="ask"><div><h3>Take a break.</h3><p>Write pause in your ${NAME} group, and nothing is transcribed anywhere until you write resume.</p></div>
${mini(`${NAME} group`, `<div class="me">pause</div><div class="bot">Paused. Nothing is transcribed until you write <b>resume</b> here.</div>`)}</div>
<div class="ask"><div><h3>Take a text back.</h3><p>Reply delete to any text ${NAME} posted, in any chat. It&#39;s removed for everyone.</p></div>
${mini('Any chat', `<div class="me">I&#39;m stuck in traffic, I&#39;ll be there in about twenty minutes. Start without me.</div><div class="me">${quote('You', 'I&#39;m stuck in traffic, I&#39;ll be there in about twenty minutes.')}delete</div>`)}</div>
<div class="ask"><div><h3>Leave.</h3><p>Write leave in your ${NAME} group. It asks first. Say yes, and it logs the device out of your WhatsApp and erases everything about you here.</p></div>
${mini(`${NAME} group`, `<div class="me">leave</div><div class="bot">Unlink <b>${NAME}</b> from your WhatsApp and erase everything about you here?<br>Reply <b>yes</b> to leave, <b>no</b> to carry on.</div><div class="me">${quote(NAME, `Unlink ${NAME} from your WhatsApp and erase everything`)}yes</div>`)}</div>
</div></div></section>
<section class="band"><div class="wrap"><h2>Nothing kept.</h2>
<div class="facts plain">
<p><b>Recordings.</b> Each one is deleted the moment it becomes text, unless you ask us to keep yours to help improve ${NAME}.</p>
<p><b>Text.</b> It lives in your WhatsApp, under the recording. It is never written to our disk.</p>
</div><p class="intro"><a href="/privacy">Privacy &amp; terms</a> has the details.</p></div></section>
${closeFor(res)}
${footFor(req, res)}`, { wide: true, nav: NAV }))));

  app.get('/privacy', (req, res) => track(req, res) ?? (isHe(res)
    ? res.type('html').send(page(res, `${PRODUCT_NAME} · ${HE.title.privacy}`, privacyHe(esc(PRODUCT_NAME))))
    : res.type('html').send(page(res, `${PRODUCT_NAME} · Privacy & terms`, `
<h1 class="small">Privacy &amp; terms</h1>
<div class="legal">
<section><h3>What ${esc(PRODUCT_NAME)} does</h3>
<p>${esc(PRODUCT_NAME)} is a transcription service: it turns recordings into readable text. In the chats you allow, it sends voice notes (and videos, where they are turned on) to speech and language models, and cleans up what was said into clear text. View-once media is never touched. In disappearing chats, the text disappears on the same timer as the recording.</p>
<p>WhatsApp is only the channel. ${esc(PRODUCT_NAME)} links to your account as a device, like WhatsApp Web, to receive the recordings and post the text back under them, as you, or, for a chat you make private, only into your own private group. It adds nothing to WhatsApp, offers no WhatsApp feature, and is not affiliated with, endorsed by or connected to WhatsApp or Meta. Your WhatsApp account stays yours, under WhatsApp&#39;s own terms.</p></section>
<section><h3>What you pay for</h3>
<p>Any paid plan pays for the transcription: the minutes of audio turned into text, and the model doing it. It is never a charge for WhatsApp, for access to WhatsApp, or for any WhatsApp feature. Those are free from WhatsApp, and ${esc(PRODUCT_NAME)} does not sell or resell them. A recording that cannot be transcribed is not counted.</p></section>
<section><h3>What we keep</h3>
<p>Your WhatsApp session keys. Your settings: which chats are on or off, the language, the names you taught it. Feedback you send from the settings page, until your account is erased. The display names of chats and people it has seen, so it can credit a speaker. A short-lived fingerprint of each recording (a hash, not the audio), so a forwarded recording can be matched to its chat. The text of a recording stays in the server&#39;s memory for up to an hour, never on disk, so forwarding the same recording doesn&#39;t transcribe it twice.</p>
<p>When you sign up: the network address it came from, a rough location (from your browser&#39;s language and time zone), the kind of device and browser, and the site that sent you, if any. Only the operator sees these, to spot abuse and to know how people find ${esc(PRODUCT_NAME)}, and they are deleted with your account. The site&#39;s pages also set a cookie holding a random number, to tell a returning browser from a new one: we note the kind of device and the referring site of its first visit, count its visits and sign-ups, and forget it after six months without a visit. It holds nothing else. Another cookie remembers the site&#39;s language, if you picked one.</p>
<p>Recordings are deleted right after they become text. The one exception: if you explicitly opt in to help improve the product, your recordings and their text are kept for a limited time and then deleted automatically, and what the service did with each one (the text, who a dictated message was matched to, what was sent) is written to the server log so a bad result can be explained. That is off unless you ask for it. Otherwise message text and transcripts are not stored. They exist only in your WhatsApp.</p></section>
<section><h3>What passes through</h3>
<p>As a linked device, every message on your account passes through this server in transit, as it would through WhatsApp Web. Only voice notes in allowed chats are processed, and videos where they are turned on, plus one kind of text: a short reply to one of our texts, from whoever spoke that recording, within a few minutes of it, which is checked as a possible correction. The rest is dropped immediately. Audio, the text and any names in it go to model providers (OpenAI, Groq, DeepInfra) under their API terms. Server logs hold counts, durations and error codes, never message text, transcripts or names.</p></section>
<section><h3>The risk</h3>
<p>To act as a linked device, ${esc(PRODUCT_NAME)} uses an unofficial WhatsApp client, which is against WhatsApp&#39;s terms of service. In rare cases WhatsApp temporarily or permanently restricts accounts that do this. You link at your own risk: ${esc(PRODUCT_NAME)} cannot prevent, lift or compensate a restriction of your WhatsApp account. If WhatsApp logs the device out or restricts the account, transcription stops until it is linked again, and on a paid plan the unused part of the period is refunded. It is provided as is, without warranty.</p></section>
<section><h3>Leaving</h3>
<p>Write <b>leave</b> in your ${esc(PRODUCT_NAME)} group in WhatsApp and confirm with <b>yes</b>. That logs the device out of your WhatsApp and deletes everything about your account here. You can also remove the device in WhatsApp under Linked devices, at any time.</p></section>
</div>
<a class="back" href="/">Back home</a>`))));

  // ---------- create + link ----------
  app.post('/start', (req, res) => {
    if (startLimiter.blocked(req.ip)) { health.noteTurnedAway('rate'); return res.status(429).type('html').send(small(res, ['Slow down', 'Too many attempts from this network. Try again in an hour.'], HE.slow)); }
    startLimiter.hit(req.ip);
    if (req.body.consent !== '1') return res.redirect(303, '/');
    if (INVITE_CODE) {
      const given = Buffer.from(String(req.body.invite || '')), want = Buffer.from(INVITE_CODE);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(403).type('html').send(small(res, ['Invite needed', `That invite code isn't right. You need one to join ${esc(PRODUCT_NAME)} for now.`], [HE.invite[0], HE.invite[1](esc(PRODUCT_NAME))], `<a class="back" href="/">${isHe(res) ? HE.home : 'Back home'}</a>`));
    }
    // Every account starts on auto-detect; the link page has a selector for the rare case it's needed.
    // Who invited them, if they arrived through someone's /i/<code> link.
    const ref = String(req.body.ref || cookies(req).rref || '');
    let t;
    // The welcome in WhatsApp is written in the browser's language when we have it (Hebrew or English).
    const locale = res.locals.lang;
    // Who this is, coarsely, for the admin page: the network address, a likely country, the device,
    // where they came from, and whether this browser was here before (see the privacy page).
    const vid = visitors.VISITOR_RE.test(cookies(req).rv || '') ? cookies(req).rv : null;
    const seen = vid ? visitors.get(vid) : null;
    const [prevId, prevKey] = String(cookies(req).rl || '').split('.');
    const prev = prevId && ID_RE.test(prevId) ? registry.get(prevId) : null;
    const tz = String(req.body.tz || '');
    const signup = {
      at: Date.now(), ip: req.ip || null, country: countryOf(req), tz: TZ_RE.test(tz) && tz.length <= 64 ? tz : null,
      device: deviceOf(String(req.get('user-agent') || '')), lang: String(req.get('accept-language') || '').split(',')[0].trim().slice(0, 16) || null,
      from: sourceHost(req.body.from) || null, invited: !!registry.byInvite(ref),
      visitor: vid, visits: seen?.visits || 0, firstSeen: seen?.first || null, earlierAccounts: (seen?.accounts || []).length,
      hadAccount: prev && hasSession(prev, prevKey) ? prev.id : null,
    };
    try {
      const a = health.admission(); if (!a.open) throw Object.assign(new Error('The server is catching its breath. Please try again in a moment.'), { why: a.why });
      t = registry.create({ language: '', locale, referredBy: ref, signup }); if (vid) visitors.addAccount(vid, t.id);
    }
    catch (e) {
      health.noteTurnedAway(e.why); health.noteError(e);
      // Full is not a queue: no place frees up in a minute, so the page says so instead of waiting on its own.
      if (e.why === 'full') return res.status(503).type('html').send(small(res, ['We\u2019re full right now', `${esc(PRODUCT_NAME)} has as many people as it can serve today, and we\u2019re making room. Please try again tomorrow. Sorry for the wait, and glad you came.`], [HE.full[0], HE.full[1](esc(PRODUCT_NAME))]));
      if (e.why) return res.status(503).type('html').send(roomPage(req, res));
      return res.status(503).type('html').send(small(res, ['Try again soon', 'Something went wrong on our side. Please try again in a few minutes.'], HE.busy));
    }
    setSession(req, res, t);
    res.append('Set-Cookie', `rref=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.redirect(303, `/link/${t.id}`);
  });

  // Sign-ups are let in a few at a time (MAX_PENDING, MAX_TENANTS): each new link costs the server
  // seconds of work, and a wave of them at once took it down. Whoever arrives while the door is
  // closed waits on this page; it asks every few seconds whether there is room and then sends
  // the same sign-up again on its own. Nothing is lost and nothing has to be refreshed.
  const hasRoom = () => health.admission().open && registry.pendingCount() < registry.MAX_PENDING && registry.list().length < registry.MAX_TENANTS;
  app.get('/api/room', (_req, res) => res.json({ room: hasRoom() }));
  function roomPage(req, res) {
    const he = isHe(res), R = HE.room;
    const fields = ['consent', 'ref', 'invite', 'tz', 'from'].filter((k) => req.body?.[k] != null).map((k) => `<input type="hidden" name="${k}" value="${esc(String(req.body[k]).slice(0, 200))}">`).join('');
    const title = he ? R.title : 'One moment, there is a queue';
    const body = he ? R.body(PRODUCT_NAME) : `Lots of people are joining ${esc(PRODUCT_NAME)} right now, and we let a few in at a time so that everyone's link comes out right. Stay on this page: the moment there is room it carries on by itself, usually within a minute or two.`;
    return page(res, title, `<h1 class="small">${title}</h1><p>${body}</p>
<form method="post" action="/start" id="again">${fields}<p class="muted" id="wait"><span class="pill"><i></i>${he ? R.waiting : 'Waiting for a free spot…'}</span></p><button class="btn" type="submit">${he ? R.now : 'Try now'}</button></form>`, { poll: `
const f=document.getElementById('again');let sent=false;
async function ask(){if(sent)return;try{const r=await fetch('/api/room',{credentials:'same-origin'});if(r.ok&&(await r.json()).room){sent=true;f.submit();return;}}catch(e){}setTimeout(ask,12000+Math.random()*8000);}
setTimeout(ask,8000);` });
  }

  /** The account named in the path, or null. */
  const accountOf = (req) => { const id = String(req.params.id || ''); return ID_RE.test(id) ? registry.get(id) : null; };
  /** The account in the path, if this browser holds one of its sessions (door.js); else null. */
  function signedIn(req) {
    const t = accountOf(req);
    const [id, token] = String(cookies(req).rl || '').split('.');
    return t && id === t.id && hasSession(t, token) ? t : null;
  }
  function auth(req, res) {
    const t = signedIn(req);
    if (!t) { res.status(404).type('html').send(small(res, ['Not found', 'This link is not valid.'], HE.notFound)); return null; }
    return t;
  }

  // Every string the link page's script draws, in English; site-he.js has the same keys in Hebrew.
  const LINK_EN = {
    starting: 'Starting…', linked: 'Linked', youreIn: 'You&#39;re in.',
    manual: 'One thing first: in WhatsApp, create a group with just you in it and post <code>#transcribe</code> there. That becomes your {p} group.',
    waiting: 'Your <b>{g}</b> group is waiting at the top of your chats. Record a voice note there and watch its text show up right under it.',
    openWa: 'Open WhatsApp', helpThere: 'Everything else happens in that group too: write <b>help</b> there.',
    open1: 'Open WhatsApp and go to <b>Settings</b> (on Android, the <b>&#8942;</b> menu)', open2: 'Tap <b>Linked devices</b>, then <b>Link a device</b>. Linked here before? Remove the old device from that list first (it shows as Ubuntu)',
    yourCode: 'Your code.', copy: 'Copy code', copied: 'Copied', withPhone: 'Tap <b>Link with phone number instead</b>', paste: 'Paste the code',
    codeNote: 'WhatsApp may also send a notification asking for the code; tapping it is a shortcut. The code is good for a few minutes, and a fresh one appears here when it expires.',
    gettingCode: 'Getting you a code…', withCode: 'Link with a code.', yourNumber: 'Your WhatsApp number', phonePh: 'Phone number', getCode: 'Get my code',
    codeFor: 'The code will be for <b>{n}</b>', country: 'Country',
    scan: 'Scan this.', point: 'Point your phone at this code',
    rescan: 'Your phone said it couldn&#39;t link? Scan this one again. WhatsApp changed the code after the first scan.', refreshes: 'The code refreshes on its own.',
    toQr: 'Scan a QR code instead', toCode: 'Link with a code instead',
    loggedOut: 'Logged out', loggedOutNote: 'WhatsApp logged this device out. A new code is coming…', reconnecting: 'Reconnecting…', preparing: 'Preparing your code…',
    unlink: 'Unlink and erase everything', orLeave: 'Or write <b>leave</b> in your {p} group.', confirm: 'Unlink WhatsApp and erase this account?', privacy: 'Privacy &amp; terms',
  };
  app.get('/link/:id', (req, res) => {
    // A support link (/admin/link) becomes a session and disappears from the address bar.
    if (req.query.k != null) {
      const t = accountOf(req);
      if (t && useEntry(t, String(req.query.k))) { setSession(req, res, t); return res.redirect(303, `/link/${t.id}`); }
    }
    const t = auth(req, res); if (!t) return;
    const S = isHe(res) ? HE.link : LINK_EN;
    // A phone cannot scan its own screen: there the default is a code, on a desktop the QR. Either page links to the other.
    const onPhone = /Mobile|Android|iPhone|iPad|iPod/i.test(req.get('user-agent') || '');
    const via = ['qr', 'code'].includes(req.query.via) ? req.query.via : onPhone ? 'code' : 'qr';
    // The number field's country. A number comes from home, not from where the phone is today: a
    // language other than English (he, el…) says the most; the phone's time zone comes next, in the page.
    const firstLang = String(req.get('accept-language') || '').split(',')[0].trim().toLowerCase();
    const country = firstLang && !firstLang.startsWith('en') ? countryFromLanguage(firstLang) : '';
    const region = countryFromLanguage(req.get('accept-language'));
    res.type('html').send(page(res, `${PRODUCT_NAME} · ${isHe(res) ? HE.title.link : 'Link your WhatsApp'}`, `
<canvas id="fx" hidden aria-hidden="true"></canvas>
<div id="box"><span class="pill"><i></i>${S.starting}</span></div>
<form method="post" action="/link/${t.id}/qr" id="toqr" hidden></form>
<div class="tools">
<form method="post" action="/unlink/${t.id}" id="unlink"><button class="quiet" type="submit">${S.unlink}</button><span class="muted">${S.orLeave.replace('{p}', esc(PRODUCT_NAME))}</span></form>
</div>
<a class="back" href="/privacy">${S.privacy}</a>`, { poll: `
const S=${JSON.stringify(S)};const fill=(x,k,v)=>x.split('{'+k+'}').join(v);
// Country names in the page's language when the browser can name them.
const regionName=(()=>{try{const d=new Intl.DisplayNames([document.documentElement.lang],{type:'region'});return (iso,fb)=>d.of(iso)||fb}catch(e){return (iso,fb)=>fb}})();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const box=()=>document.getElementById('box');const product=${JSON.stringify(PRODUCT_NAME)};
// Into the app itself, where the group is; on a computer, WhatsApp Web.
const openWa=${JSON.stringify(onPhone ? 'whatsapp://' : 'https://web.whatsapp.com/')};
let via='${via}',shown='';
const open='<li>'+S.open1+'</li><li>'+S.open2+'</li>';
const countries=${JSON.stringify(COUNTRIES)};
const flag=(iso)=>String.fromCodePoint(...[...iso].map(ch=>127397+ch.charCodeAt(0)));
const tz=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){return ''}})();
const home=(countries.find(c=>c[0]==='${country}')||countries.find(c=>c[3].includes(tz))||countries.find(c=>c[0]==='${region}')||countries.find(c=>c[0]===(navigator.language||'').split('-')[1])||countries.find(c=>c[0]==='US'))[0];
// The same rule as the server: + or 00 means as typed; otherwise the country code goes in front of the local form.
function intl(v,cc){const raw=String(v||'').trim();let d=raw.replace(/\\D/g,'');if(raw.startsWith('+')){}else if(d.startsWith('00'))d=d.slice(2);else if(cc&&!(d.startsWith(cc)&&d.length-cc.length>=8&&!d.startsWith('0')))d=cc+(cc==='39'?d:d.replace(/^0/,''));return /^[1-9]\\d{7,14}$/.test(d)?d:null}
function phoneForm(){const opts=countries.map(c=>'<option value="'+c[0]+'"'+(c[0]===home?' selected':'')+'>'+flag(c[0])+' '+esc(regionName(c[0],c[2]))+' (+'+c[1]+')</option>').join('');const h=countries.find(c=>c[0]===home);return '<h1>'+S.withCode+'</h1><form class="phone" method="post" action="/link/${t.id}/code"><label for="phone">'+S.yourNumber+'</label><div class="tel"><div class="cc"><em id="ccflag">'+flag(h[0])+'</em><span id="ccdial">+'+h[1]+'</span><svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg><select id="ccsel" aria-label="'+S.country+'">'+opts+'</select></div><input type="hidden" name="cc" id="cc" value="'+h[1]+'"><input type="tel" id="phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="'+(h[0]==='IL'?'050 123 4567':S.phonePh)+'" required></div><p class="hint" id="as"></p><button class="cta" type="submit">'+S.getCode+'</button></form>';}
function syncPhone(){const sel=document.getElementById('ccsel');if(!sel)return;const c=countries.find(x=>x[0]===sel.value);document.getElementById('ccflag').textContent=flag(c[0]);document.getElementById('ccdial').textContent='+'+c[1];document.getElementById('cc').value=c[1];const ph=document.getElementById('phone');ph.placeholder=c[0]==='IL'?'050 123 4567':S.phonePh;const d=intl(ph.value,c[1]);const shown=d?'+'+c[1]+' '+d.slice(c[1].length).replace(/(\\d{2,3})(\\d{3})(\\d{4})$/,'$1 $2 $3'):'';document.getElementById('as').innerHTML=d?fill(S.codeFor,'n',esc(d.startsWith(c[1])?shown:'+'+d)):'';}
document.addEventListener('input',e=>{if(e.target.id==='phone')syncPhone();});
document.addEventListener('change',e=>{if(e.target.id==='ccsel')syncPhone();});
async function copyCode(code,btn){try{await navigator.clipboard.writeText(code);}catch(e){const ta=document.createElement('textarea');ta.value=code;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(_){}ta.remove();}if(btn){btn.textContent=S.copied;setTimeout(()=>{btn.textContent=S.copy;},2000);}}
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;e.preventDefault();copyCode(b.dataset.copy,document.getElementById('copybtn'));});
const swap=(to)=>'<a href="#" class="swap" data-to="'+to+'">'+(to==='qr'?S.toQr:S.toCode)+'</a>';
document.addEventListener('click',e=>{const a=e.target.closest('a.swap');if(!a)return;e.preventDefault();if(a.dataset.to==='qr'&&document.body.dataset.code==='1'){document.getElementById('toqr').submit();return;}via=a.dataset.to;shown='';tick();});
document.getElementById('unlink').addEventListener('submit',e=>{if(!confirm(S.confirm))e.preventDefault();});
// Confetti, once, the moment the link goes through — not for someone coming back to a linked account.
let wasLinked=null;
function confetti(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const c=document.getElementById('fx'),x=c.getContext('2d');c.hidden=false;const W=c.width=innerWidth,H=c.height=innerHeight;const cols=['#25d366','#121212','#d9fdd3','#faf7f2','#1fa855'];const ps=Array.from({length:160},()=>({x:W/2+(Math.random()-.5)*W*.3,y:H*.35,vx:(Math.random()-.5)*14,vy:-Math.random()*16-4,r:Math.random()*Math.PI,vr:(Math.random()-.5)*.3,w:6+Math.random()*6,h:8+Math.random()*10,c:cols[Math.random()*cols.length|0]}));const t0=performance.now();(function f(t){const k=(t-t0)/1000;x.clearRect(0,0,W,H);for(const p of ps){p.vy+=.35;p.x+=p.vx;p.y+=p.vy;p.vx*=.99;p.r+=p.vr;x.save();x.translate(p.x,p.y);x.rotate(p.r);x.globalAlpha=Math.max(0,1-Math.max(0,k-2)/1);x.fillStyle=p.c;x.fillRect(-p.w/2,-p.h/2,p.w,p.h);x.restore();}if(k<3.2)requestAnimationFrame(f);else{c.hidden=true;}})(t0);}
let timer=null;
async function tick(){clearTimeout(timer);let s=null;try{const r=await fetch('/api/link/${t.id}',{credentials:'same-origin'});if(r.ok)s=await r.json();}catch(e){}if(s&&s.mode==='connected'&&!s.needsManualGroup){render(s);return;}timer=setTimeout(tick,2500);if(s)render(s);}
function render(s){
 document.body.classList.toggle('on',!!s.linkedAt);
 document.body.dataset.code=s.pairByCode?'1':'';
 // Linked: the settings page takes over, with the welcome if it happened just now.
 if(s.mode==='connected'&&!s.needsManualGroup){clearTimeout(timer);location.replace('/settings/${t.id}'+(wasLinked===false?'?welcome=1':''));return;}
 if(s.mode==='connected'&&wasLinked===false)confetti();
 wasLinked=s.mode==='connected';
 // The same picture is not redrawn: a number being typed must survive the next poll.
 const key=[s.mode,s.pairByCode,s.pairingCode,via==='qr'&&!s.pairByCode&&s.qr?s.qr.slice(-40):'',via,s.rescan,s.controlGroup,s.needsManualGroup].join('|');if(key===shown)return;shown=key;
 if(s.mode==='connected'){box().innerHTML='<span class="pill ok"><i></i>'+S.linked+'</span><h1>'+S.youreIn+'</h1>'+(s.needsManualGroup?'<p class="go">'+fill(S.manual,'p',esc(product))+'</p>':'<p class="go">'+fill(S.waiting,'g',esc(s.controlGroup||product))+'</p>')+'<a class="cta" href="'+openWa+'">'+S.openWa+'</a><p class="muted">'+S.helpThere+'</p>';}
 else if(s.mode==='qr'&&s.pairingCode){const c=String(s.pairingCode);box().innerHTML='<h1>'+S.yourCode+'</h1><button class="code" type="button" data-copy="'+esc(c)+'" aria-label="'+S.copy+'">'+esc(c.slice(0,4))+'<i>-</i>'+esc(c.slice(4))+'</button><button class="cta" type="button" id="copybtn" data-copy="'+esc(c)+'">'+S.copy+'</button><ol class="howto">'+open+'<li>'+S.withPhone+'</li><li>'+S.paste+'</li></ol><p class="muted">'+S.codeNote+'</p>'+swap('qr');}
 else if(s.mode==='qr'&&s.pairByCode){box().innerHTML='<span class="pill"><i></i>'+S.gettingCode+'</span>'+swap('qr');}
 else if(s.mode==='qr'&&via==='code'){box().innerHTML=phoneForm()+swap('qr');}
 else if(s.qr){box().innerHTML='<h1>'+S.scan+'</h1><ol class="howto">'+open+'<li>'+S.point+'</li></ol><img class="qr" src="'+esc(s.qr)+'" alt="QR code">'+(s.rescan?'<p class="go center">'+S.rescan+'</p>':'<p class="muted center">'+S.refreshes+'</p>')+swap('code');}
 else if(s.mode==='logged_out'){box().innerHTML='<span class="pill"><i></i>'+S.loggedOut+'</span><p>'+S.loggedOutNote+'</p>';}
 else{box().innerHTML='<span class="pill"><i></i>'+(s.mode==='reconnecting'?S.reconnecting:S.preparing)+'</span>';}
}
tick();` }));
  });

  // The link page asks every few seconds: while it does, someone is in front of a QR code or a pairing code.
  app.get('/api/link/:id', (req, res) => { const t = auth(req, res); if (t) { t.wake(); res.json(t.status({ full: true })); } });

  // Link with a code: the number stays with the account until it is linked or the QR is chosen again.
  app.post('/link/:id/code', async (req, res) => {
    const t = auth(req, res); if (!t) return;
    // The number as typed (local, or with + / 00) and the country picked next to it.
    const phone = normalizePhone(req.body.phone, req.body.cc);
    if (!phone) return res.status(400).type('html').send(small(res, ['That doesn&#39;t look like a number.', 'Type your WhatsApp number the way you&#39;d give it to a friend, and check the country next to it.'], HE.notNumber, `<a class="back" href="/link/${t.id}?via=code">${isHe(res) ? HE.back : 'Back'}</a>`));
    t.wake();
    await t.requestPairingCode(phone);
    res.redirect(303, `/link/${t.id}`);
  });
  app.post('/link/:id/qr', (req, res) => {
    const t = auth(req, res); if (!t) return;
    t.usePairingQr();
    res.redirect(303, `/link/${t.id}?via=qr`);
  });

  app.post('/unlink/:id', async (req, res) => {
    const t = auth(req, res); if (!t) return;
    const r = await registry.remove(t.id);
    clearSession(req, res);
    if (isHe(res)) return res.type('html').send(page(res, 'נעלם', `${HE.gone(esc(PRODUCT_NAME), r?.loggedOut)}<a class="back" href="/">${HE.again}</a>`));
    res.type('html').send(page(res, 'Unlinked', `<h1 class="small">Gone.</h1><p>Nothing of yours is left here.${r?.loggedOut ? ' The device was logged out of your WhatsApp.' : ' WhatsApp did not confirm the logout, so remove the device yourself under <b>WhatsApp → Linked devices</b>.'} The <b>${esc(PRODUCT_NAME)}</b> group stays in your WhatsApp; delete it whenever you like.</p><a class="back" href="/">Start over</a>`));
  });

  // ---------- settings ----------
  // What is transcribed and where the text goes (settings.js). Right after linking it is the welcome, with a
  // button into WhatsApp; later the "settings" command sends a link to it. Every change is saved at once.
  const SETTINGS_EN = {
    title: 'Settings', on: 'is on', off: 'is off', saved: 'Saved', failed: 'Not saved', done: 'Done',
    whereTitle: 'Where transcripts appear', chat: 'In the chat', me: 'Only to me',
    whereChat: 'Right under each voice note, so everyone in the chat can read it.', whereMe: 'In a WhatsApp group with only you in it. Nothing is posted in your chats.',
    whatTitle: 'What to transcribe',
    whereMixed: 'Right now: private chats in the chat, groups only to you. Picking one here sets both.',
    whoTitle: 'Which voice notes to transcribe', mine: 'Only mine', others: 'Only others’', all: 'Everyone’s', toggle: 'Transcribe', remove: 'Remove',
    chats: { title: 'Private chats', all: 'All private chats', some: 'Only people you chose', pick: 'Pick people', change: 'Change', back: 'Back to all private chats', sheet: 'Choose people', ph: 'Search a name or a number', note: 'Only the people you tick are transcribed. Not here? Type their number.' },
    groups: { title: 'Groups', all: 'All groups', some: 'Only groups you chose', pick: 'Pick groups', change: 'Change', back: 'Back to all groups', sheet: 'Choose groups', ph: 'Search your groups', note: 'Only the groups you tick are transcribed.' },
    recentChats: 'The {n} people you talked with most recently. Archived and muted chats aren’t listed here; search finds anyone.',
    recentGroups: 'The {n} most active groups. Archived and muted ones aren’t listed here; search finds any group.',
    more: 'Showing {n} of {t}. Type a name to find the rest.', members: '{n} members', contact: 'Contact', loading: 'Loading…', none: 'Nothing found.',
    noChats: 'No chats yet. Right after linking they take a minute to come over from WhatsApp.',
    noGroups: 'No groups yet. The {p} group isn’t listed: it’s always on.',
    paused: 'Transcription is paused. To start again, write <b>resume</b> in your {p} group.',
    foot: '<b>To get back here,</b> write <b>settings</b> in the <b>{p}</b> group we made for you in WhatsApp.',
    langTitle: 'Transcription language', auto: 'Detect automatically (recommended)', langNote: 'Each voice note’s language is detected on its own. Pick one only if it keeps getting it wrong.',
    unlink: 'Unlink and erase', byeTitle: 'Unlink and erase everything?', byeGo: 'Unlink and erase',
    byeText: 'We’ll unlink {p} from your WhatsApp and erase all your data and settings. This can’t be undone. The {p} group stays in your WhatsApp, and you can delete it.',
    feedback: 'Feedback or a problem', fbTitle: 'Send feedback or report a problem', fbPh: 'What works, what doesn’t, what’s missing?', fbSend: 'Send', fbCancel: 'Cancel',
    fbThanks: 'Thanks! It reached us.', fbFailed: 'Not sent. Try again in a moment.', fbNote: 'Only we read this. If needed, we’ll get back to you on WhatsApp.',
    banner: 'You’re in. WhatsApp is linked.', cta: 'Send yourself a voice note',
  };
  const SETTINGS_CSS = `.st{display:flex;flex-direction:column;gap:9px;padding:10px 0 24px}.secs{display:flex;flex-direction:column;gap:9px}.st.cta-on{padding-bottom:92px}
.sthead{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:46px}
.sthead h1{display:flex;align-items:center;gap:11px;font-size:30px;line-height:1;letter-spacing:-.03em;white-space:nowrap}.sthead h1 svg{width:38px;height:38px;flex:none}
.sthead h1 span{color:var(--ink)}.sthead em{font-style:normal;color:#1fa855}.sthead em.off{color:#8c877c}
.chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border-radius:999px;background:var(--ink);color:#fff;font-size:13px;font-weight:600;flex:none}.chip.bad{background:var(--danger)}.chip[hidden]{display:none}
.box{background:#fff;border:1px solid var(--line);border-radius:18px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.box.where{background:#eaf6ec;border-color:#c9e6cf}.box.where h2{margin-bottom:4px}.box h2{font-size:20px;font-weight:700;letter-spacing:-.02em;line-height:1.15}
.seg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;background:#efeae0;border-radius:13px;padding:3px}.where .seg{background:rgba(31,168,85,.12)}
.seg.three{grid-template-columns:repeat(3,minmax(0,1fr))}.seg.three button{font-size:14px;padding:0 4px;white-space:nowrap}@media(max-width:350px){.seg.three button{font-size:13px;padding:0 2px;letter-spacing:-.01em}}
.seg button{min-height:40px;border:0;border-radius:10px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;color:var(--ink);background:transparent}
.seg button[aria-pressed=true]{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.st .note{font-size:13px;color:#4f6656}.st .pause{font-size:14px;color:var(--ink);background:#fff3d6;border-radius:14px;padding:10px 14px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.sw{flex:none;position:relative;width:52px;height:32px;border-radius:999px;border:0;padding:0;cursor:pointer;background:#d6d1c6}.sw[aria-pressed=true]{background:var(--green)}
.sw span{position:absolute;top:3px;inset-inline-start:3px;width:26px;height:26px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:inset-inline-start .15s}.sw[aria-pressed=true] span{inset-inline-start:23px}
.in{display:flex;flex-direction:column;gap:6px}.in .q{font-size:13px;font-weight:600;color:var(--mute)}
.scope{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:32px;border-top:1px solid #efeae0;padding-top:4px}
.scope>span{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600}.scope svg{flex:none}
.lnk{min-height:36px;padding:0 2px;border:0;background:transparent;font:inherit;font-size:14px;font-weight:600;color:var(--ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer;flex:none}.lnk.mute{color:var(--mute);align-self:flex-start}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips>span{display:inline-flex;align-items:center;gap:8px;height:34px;max-width:100%;padding-inline:12px 5px;border-radius:999px;background:var(--bg);border:1px solid var(--line);font-size:14px;font-weight:600}
.chips>span>i{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chips button{width:26px;height:26px;border-radius:50%;border:0;background:#ece7dd;display:grid;place-items:center;cursor:pointer;padding:0;flex:none}
.st .label{margin:4px 2px -1px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}[dir=rtl] .st .label{letter-spacing:0;text-transform:none}
.sep{width:100%;border:0;border-top:1px solid var(--line);margin:8px 0 2px}
.lang{display:flex;flex-direction:column;gap:6px}.lang label{margin:0;color:var(--ink);font-weight:600;font-size:15px}.lang select{height:46px}.hint2{font-size:13px;color:var(--mute)}
.stfoot{margin-top:4px;color:var(--mute);font-size:13px}.stfoot b{font-weight:600}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}.acts>*{flex:1 1 0;min-width:max-content}.acts form{display:flex}
.act{flex:1;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 12px;border-radius:999px;border:1.5px solid var(--line);background:#fff;color:var(--ink);font:inherit;font-size:14px;font-weight:600;cursor:pointer}.act.bad{background:transparent;border-color:#e3b4b0;color:var(--danger)}
.panel textarea{width:100%;min-height:140px;padding:12px 14px;border-radius:14px;border:1.5px solid var(--ink);background:#fff;color:var(--ink);font:inherit;font-size:16px;resize:vertical}
.fbrow{display:flex;gap:8px}.fbrow .act,.fbrow .donebtn{flex:1;min-height:46px}
.sheet.pop{justify-content:center;padding:16px}.pop .panel{border-radius:24px;max-height:100%;overflow-y:auto;padding:18px}.pop textarea{min-height:120px}
.byet{color:var(--ink);font-size:15px;line-height:1.45}.act.kill{background:var(--danger);border-color:var(--danger);color:#fff}
.ctabar{position:fixed;left:0;right:0;bottom:0;z-index:3;background:var(--bg);border-top:1px solid var(--line);padding:8px 18px calc(10px + env(safe-area-inset-bottom))}
.ctabar a{display:flex;align-items:center;justify-content:center;gap:10px;max-width:464px;margin:0 auto;min-height:48px;border-radius:999px;background:var(--green);color:var(--ink);font-weight:600;font-size:17px;text-decoration:none}
.toast{position:fixed;inset:0;z-index:8;display:grid;place-items:center;background:rgba(250,247,242,.82);animation:fadeout 2.9s ease forwards;pointer-events:none}
.toast>div{display:flex;flex-direction:column;align-items:center;gap:14px;max-width:300px;padding:26px 30px;border-radius:26px;background:var(--ink);color:#fff;box-shadow:0 18px 50px rgba(0,0,0,.25);animation:pop .55s cubic-bezier(.2,1.4,.4,1) both}
.toast i{width:54px;height:54px;border-radius:50%;background:var(--green);display:grid;place-items:center}
.toast b,main.narrow .toast b{color:#fff;font-family:var(--disp);font-weight:700;font-size:22px;line-height:1.2;text-align:center;letter-spacing:-.01em}
@keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}@keyframes fadeout{0%,82%{opacity:1}100%{opacity:0;visibility:hidden}}
.sheet{position:fixed;inset:0;z-index:6;background:rgba(18,18,18,.45);display:flex;flex-direction:column;justify-content:flex-end}.sheet[hidden]{display:none}
.panel{width:100%;max-width:500px;max-height:88vh;touch-action:pan-y;margin:0 auto;background:var(--bg);border-radius:24px 24px 0 0;padding:10px 18px calc(16px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:12px}
.grab{align-self:center;width:40px;height:5px;border-radius:3px;background:#d6d1c6;background-clip:content-box;box-sizing:content-box;padding:8px 40px;margin:-8px 0;cursor:grab}
#sheet .panel{height:88%;max-height:none}.panel h3{font-size:22px;font-weight:700;letter-spacing:-.02em}
.donebtn{min-height:44px;padding:0 16px;border:0;border-radius:999px;background:var(--green);font:inherit;font-size:15px;font-weight:600;color:var(--ink);cursor:pointer}
.search{display:flex;align-items:center;gap:10px;height:50px;margin:0;padding:0 14px;border-radius:14px;background:#fff;border:1.5px solid var(--ink)}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:16px;color:var(--ink)}
.list{flex:1;min-height:120px;overflow-y:auto;display:flex;flex-direction:column}.list p{color:var(--mute);font-size:15px;padding:12px 4px}
.pick{display:flex;align-items:center;gap:12px;width:100%;min-height:54px;padding:5px 4px;border:0;border-bottom:1px solid var(--line);background:transparent;font:inherit;color:var(--ink);cursor:pointer;text-align:start}
.pick .av{flex:none;width:36px;height:36px;border-radius:50%;color:#fff;display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:15px}
.c0{background:#3d6b55}.c1{background:#8a5a44}.c2{background:#4b5a8a}.c3{background:#7a4f7a}.c4{background:#5a6b3d}.c5{background:#8a6a2e}
.nm{flex:1;min-width:0;display:flex;flex-direction:column}.nm b{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nm span{color:var(--mute);font-size:13px}
.ck{flex:none;width:24px;height:24px;box-sizing:border-box;border-radius:7px;display:grid;place-items:center;background:#fff;border:2px solid #8c877c}.pick[aria-pressed=true] .ck{background:var(--ink);border-color:var(--ink)}
.panel .note{color:var(--mute);font-size:13px}`;
  // The page's script: draws the settings from the state, saves each change as it is made.
  const SETTINGS_JS = `const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fill=(x,k,v)=>String(x).split('{'+k+'}').join(v);
const CHECK='<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#d9fdd3"/><path d="M4.5 8.3l2.2 2.2L11.5 5.7" fill="none" stroke="#1fa855" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TICK='<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const X='<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="#5c5a55" stroke-width="1.8" stroke-linecap="round"/></svg>';
const $=id=>document.getElementById(id);
const dirs={chats:null,groups:null};let sheet=null,q='',extra=null,flashT=null,top=new Set();
const MAX_ROWS=500,TOP=100;
function live(){return !st.paused&&(st.chats.on||st.groups.on);}
function section(k){const v=st[k],w=S[k],some=v.some.length>0;
 let h='<section class="box"><div class="top"><h2>'+w.title+'</h2><button type="button" class="sw" data-act="toggle" data-k="'+k+'" aria-pressed="'+v.on+'" aria-label="'+esc(S.toggle+' '+w.title)+'"><span></span></button></div>';
 if(v.on){h+='<div class="in">';
  h+='<p class="q">'+S.whoTitle+'</p><div class="seg three">'+['mine','others','all'].map(id=>'<button type="button" data-act="who" data-k="'+k+'" data-v="'+id+'" aria-pressed="'+(v.who===id)+'">'+S[id]+'</button>').join('')+'</div>';
  h+='<div class="scope"><span>'+CHECK+(some?w.some:w.all)+'</span><button type="button" class="lnk" data-act="pick" data-k="'+k+'">'+(some?w.change:w.pick)+'</button></div>';
  if(some)h+='<div class="chips">'+v.some.map(c=>'<span><i>'+esc(c.name)+'</i><button type="button" data-act="unpick" data-k="'+k+'" data-id="'+esc(c.id)+'" aria-label="'+esc(S.remove+' '+c.name)+'">'+X+'</button></span>').join('')+'</div><button type="button" class="lnk mute" data-act="all" data-k="'+k+'">'+w.back+'</button>';
  h+='</div>';}
 return h+'</section>';}
function render(){
 const on=live();$('status').textContent=on?S.on:S.off;$('status').className=on?'':'off';
 $('where').innerHTML=['chat','me'].map(id=>'<button type="button" data-act="where" data-v="'+id+'" aria-pressed="'+(st.where===id)+'">'+S[id]+'</button>').join('');
 $('whereNote').textContent=fill(st.where==='me'?S.whereMe:st.where==='chat'?S.whereChat:S.whereMixed,'p',P);
 $('pause').hidden=!st.paused;$('lang').value=st.language||'';
 $('secs').innerHTML=section('chats')+section('groups');
 const a=$('cta');if(a&&st.groupLink)a.href=st.groupLink;
 if(sheet)list();}
function flash(ok){const c=$('saved');c.hidden=false;c.className=ok?'chip':'chip bad';c.lastChild.textContent=ok?S.saved:S.failed;clearTimeout(flashT);flashT=setTimeout(()=>{c.hidden=true},ok?1800:4000);}
let chain=Promise.resolve();
function save(patch){
 if(patch.where){st.where=patch.where;for(const k of ['chats','groups'])st[k].where=patch.where;}
 const body={...(patch.where?{where:patch.where}:{})};
 if('language' in patch){st.language=patch.language;body.language=patch.language;}
 for(const k of ['chats','groups'])if(patch[k]){Object.assign(st[k],patch[k]);body[k]={...patch[k]};if(patch[k].some)body[k].some=patch[k].some.map(c=>c.id);}
 render();
 chain=chain.then(()=>fetch('/api/settings/'+ID,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))
  .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}).then(v=>{st=v;render();flash(true);}).catch(()=>flash(false));}
const avatar=n=>{let h=0;for(const c of n)h=(h*31+c.charCodeAt(0))%997;return 'c'+(h%6);};
async function load(k){if(dirs[k]&&dirs[k].length)return;try{const r=await fetch('/api/settings/'+ID+'/chats?kind='+k,{credentials:'same-origin'});dirs[k]=r.ok?(await r.json()).rows:[];}catch(e){dirs[k]=[];}if(sheet===k)list();}
function hint(k,row){if(k==='groups')return row[2]?fill(S.members,'n',row[2]):'';if(row[2])return S.contact;return /@s\\.whatsapp\\.net$/.test(row[0])&&row[1]!=='+'+row[0].split('@')[0]?'+'+row[0].split('@')[0]:'';}
function list(){const k=sheet,el=$('list');if(!dirs[k]){el.innerHTML='<p>'+S.loading+'</p>';return;}
 if(!dirs[k].length&&!q.trim()&&!st[k].some.length){el.innerHTML='<p>'+fill(k==='groups'?S.noGroups:S.noChats,'p',esc(P))+'</p>';return;}
 const chosen=new Map(st[k].some.map(c=>[c.id,c.name]));const needle=q.trim().toLowerCase(),digits=q.replace(/\\D/g,'');
 const match=r=>!needle||r[1].toLowerCase().includes(needle)||(digits.length>=3&&r[0].split('@')[0].includes(digits));
 // Before a search: the most recently active, without archived or muted chats. A search finds any.
 let rows=dirs[k].filter(r=>needle||!r[4]||chosen.has(r[0])).filter(match);
 const cut=!needle&&dirs[k].length>0;
 // What was picked before the picker opened comes first; ticking now never moves a row under the finger.
 if(!needle){const picked=[...chosen].filter(([id])=>!dirs[k].some(r=>r[0]===id)).map(([id,name])=>[id,name,0]);rows=[...picked,...rows].sort((a,b)=>top.has(b[0])-top.has(a[0]));}
 if(cut)rows=rows.slice(0,top.size+TOP);
 if(extra&&extra[0]&&!rows.some(r=>r[0]===extra[0]))rows.unshift(extra);
 el.innerHTML=rows.length?rows.slice(0,MAX_ROWS).map(r=>{const on=chosen.has(r[0]),h=hint(k,r);return '<button type="button" class="pick" data-act="flip" data-id="'+esc(r[0])+'" data-name="'+esc(r[1])+'" aria-pressed="'+on+'"><span class="av '+avatar(r[1])+'">'+esc(Array.from(r[1].replace(/^\\+/,''))[0]||'?')+'</span><span class="nm"><b>'+esc(r[1])+'</b>'+(h?'<span><bdi>'+esc(h)+'</bdi></span>':'')+'</span><span class="ck">'+(on?TICK:'')+'</span></button>';}).join('')+(rows.length>MAX_ROWS?'<p>'+fill(fill(S.more,'n',MAX_ROWS),'t',rows.length)+'</p>':'')+(cut?'<p>'+fill(k==='groups'?S.recentGroups:S.recentChats,'n',TOP)+'</p>':''):'<p>'+S.none+'</p>';}
let numT=null;
function lookNumber(){clearTimeout(numT);extra=null;const d=q.replace(/\\D/g,'');if(sheet!=='chats'||d.length<7)return;numT=setTimeout(async()=>{try{const r=await fetch('/api/settings/'+ID+'/number?q='+encodeURIComponent(q),{credentials:'same-origin'});const j=r.ok?await r.json():null;if(j&&j.row&&sheet==='chats'){extra=j.row;list();}}catch(e){}},500);}
function open(k){sheet=k;q='';extra=null;top=new Set(st[k].some.map(c=>c.id));$('shTitle').textContent=S[k].sheet;$('q').value='';$('q').placeholder=S[k].ph;$('q').setAttribute('aria-label',S[k].ph);$('shNote').textContent=S[k].note;$('sheet').hidden=false;list();load(k);}
function close(){sheet=null;$('sheet').hidden=true;}
document.addEventListener('click',e=>{
 if(e.target.id==='sheet'){close();return;}
 if(e.target.id==='fb'){$('fb').hidden=true;return;}
 const b=e.target.closest('[data-act]');if(!b)return;const k=b.dataset.k,act=b.dataset.act;
 if(act==='where')save({where:b.dataset.v});
 else if(act==='toggle')save({[k]:{on:!st[k].on}});
 else if(act==='who')save({[k]:{who:b.dataset.v}});
 else if(act==='pick')open(k);
 else if(act==='all')save({[k]:{some:[]}});
 else if(act==='unpick')save({[k]:{some:st[k].some.filter(c=>c.id!==b.dataset.id)}});
 else if(act==='close')close();
 else if(act==='fb'){$('fbNote').textContent=S.fbNote;$('fb').hidden=false;fit();$('fbText').focus();}
 else if(act==='byeclose')$('bye').hidden=true;
 else if(act==='byego')$('unlink').submit();
 else if(act==='fbclose')$('fb').hidden=true;
 else if(act==='fbsend')sendFeedback(b);
 else if(act==='flip'){const id=b.dataset.id,s=st[sheet].some;save({[sheet]:{some:s.some(c=>c.id===id)?s.filter(c=>c.id!==id):[...s,{id,name:b.dataset.name}]}});}
});
// The picker is a drawer: dragged down by its top part (the handle and the title) it closes.
(()=>{const p=$('sheet').querySelector('.panel');let y0=null,dy=0;
 p.addEventListener('touchstart',e=>{if(e.target.closest('.list,input,button'))return;y0=e.touches[0].clientY;dy=0;p.style.transition='none';},{passive:true});
 p.addEventListener('touchmove',e=>{if(y0==null)return;dy=Math.max(0,e.touches[0].clientY-y0);p.style.transform='translateY('+dy+'px)';},{passive:true});
 p.addEventListener('touchend',()=>{if(y0==null)return;y0=null;p.style.transition='transform .18s ease';p.style.transform='';if(dy>90)close();});})();
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(sheet)close();$('fb').hidden=true;$('bye').hidden=true;}});
// A phone's keyboard covers the bottom of the page without resizing it: the pop-ups fit the part still visible.
function fit(){const v=window.visualViewport;if(!v)return;for(const el of [$('fb'),$('bye'),$('sheet')]){el.style.top=v.offsetTop+'px';el.style.height=v.height+'px';el.style.bottom='auto';}}
if(window.visualViewport){visualViewport.addEventListener('resize',fit);visualViewport.addEventListener('scroll',fit);fit();}
$('lang').addEventListener('change',e=>save({language:e.target.value}));
async function sendFeedback(b){const text=$('fbText').value.trim();if(!text){$('fbText').focus();return;}b.disabled=true;
 try{const r=await fetch('/api/settings/'+ID+'/feedback',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({text})});if(!r.ok)throw new Error(r.status);
  $('fbText').value='';$('fbNote').textContent=S.fbThanks;setTimeout(()=>{$('fb').hidden=true;},1600);}
 catch(e){$('fbNote').textContent=S.fbFailed;}b.disabled=false;}
$('q').addEventListener('input',e=>{q=e.target.value;lookNumber();list();});
$('unlink').addEventListener('submit',e=>{if($('bye').hidden){e.preventDefault();$('bye').hidden=false;fit();}});
render();
if(location.search)history.replaceState(null,'',location.pathname);
// Right after linking the group may still be on its way: ask for its link a few times.
if($('cta')&&!st.groupLink){let n=0;(async function ask(){try{const r=await fetch('/api/settings/'+ID+'/group-link',{credentials:'same-origin'});const j=r.ok?await r.json():null;if(j&&j.groupLink){st.groupLink=j.groupLink;$('cta').href=j.groupLink;return;}}catch(e){}if(++n<12)setTimeout(ask,4000);})();}
if($('toast')){const c=$('fx'),x=c.getContext('2d');if(!matchMedia('(prefers-reduced-motion: reduce)').matches){c.hidden=false;const W=c.width=innerWidth,H=c.height=innerHeight;const cols=['#25d366','#121212','#d9fdd3','#faf7f2','#1fa855'];const ps=Array.from({length:160},()=>({x:W/2+(Math.random()-.5)*W*.3,y:H*.35,vx:(Math.random()-.5)*14,vy:-Math.random()*16-4,r:Math.random()*Math.PI,vr:(Math.random()-.5)*.3,w:6+Math.random()*6,h:8+Math.random()*10,c:cols[Math.random()*cols.length|0]}));const t0=performance.now();(function f(t){const k=(t-t0)/1000;x.clearRect(0,0,W,H);for(const p of ps){p.vy+=.35;p.x+=p.vx;p.y+=p.vy;p.vx*=.99;p.r+=p.vr;x.save();x.translate(p.x,p.y);x.rotate(p.r);x.globalAlpha=Math.max(0,1-Math.max(0,k-2)/1);x.fillStyle=p.c;x.fillRect(-p.w/2,-p.h/2,p.w,p.h);x.restore();}if(k<3.2)requestAnimationFrame(f);else c.hidden=true;})(t0);}
 setTimeout(()=>$('toast').remove(),2900);}`;
  const MIC_SVG = '<svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true"><rect x="4.5" y="1" width="7" height="12" rx="3.5" fill="#121212"/><path d="M1.5 9.5a6.5 6.5 0 0 0 13 0M8 16v3" fill="none" stroke="#121212" stroke-width="2" stroke-linecap="round"/></svg>';
  const SEARCH_SVG = '<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="6" fill="none" stroke="#5c5a55" stroke-width="2"/><path d="M13 13l5 5" stroke="#5c5a55" stroke-width="2" stroke-linecap="round"/></svg>';
  function settingsPage(req, res, t, { welcome = false } = {}) {
    const he = isHe(res), S = he ? HE.settings : SETTINGS_EN, nonce = res.locals.nonce;
    const view = t.settingsView();
    // Until the first voice note, the page leads into WhatsApp: on a phone the group's link opens the app.
    const onPhone = /Mobile|Android|iPhone|iPad|iPod/i.test(req.get('user-agent') || '');
    const cta = welcome || !view.firstNoteAt;
    const fallback = onPhone ? 'whatsapp://' : 'https://web.whatsapp.com/';
    const fillP = (x) => x.split('{p}').join(esc(PRODUCT_NAME));
    return page(res, `${PRODUCT_NAME} · ${S.title}`, `<style nonce="${nonce}">${SETTINGS_CSS}</style>
<canvas id="fx" hidden aria-hidden="true"></canvas>
<div class="st${cta ? ' cta-on' : ''}">
<div class="sthead"><h1>${LOGO_SVG}<span>${esc(PRODUCT_NAME)} <em id="status">${S.on}</em></span></h1><span class="chip" id="saved" role="status" hidden><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="#25d366" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${S.saved}</span></span></div>
<p class="pause" id="pause" hidden>${fillP(S.paused)}</p>
<section class="box where"><h2>${S.whereTitle}</h2><div class="seg" id="where"></div><p class="note" id="whereNote"></p></section>
<p class="label">${S.whatTitle}</p>
<div id="secs" class="secs"></div>
<hr class="sep">
<div class="lang"><label for="lang">${S.langTitle}</label><select id="lang">${LANGUAGES.map(([code, , en, heName]) => `<option value="${code}"${code === view.language ? ' selected' : ''}>${code ? (he ? heName : en) : S.auto}</option>`).join('')}</select><p class="hint2">${S.langNote}</p></div>
<hr class="sep">
<p class="stfoot">${fillP(S.foot)}</p>
<div class="acts"><button type="button" class="act" data-act="fb">${S.feedback}</button><form method="post" action="/unlink/${t.id}" id="unlink"><button class="act bad" type="submit">${S.unlink}</button></form></div>
</div>
${cta ? `<div class="ctabar"><a id="cta" href="${esc(view.groupLink || fallback)}">${MIC_SVG}${S.cta}</a></div>` : ''}
${welcome ? `<div class="toast" id="toast" role="status"><div><i><svg width="26" height="26" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="#121212" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></i><b>${S.banner}</b></div></div>` : ''}
<div class="sheet" id="sheet" hidden><div class="panel" role="dialog" aria-modal="true" aria-labelledby="shTitle"><span class="grab"></span>
<div class="top"><h3 id="shTitle"></h3><button type="button" class="donebtn" data-act="close">${S.done}</button></div>
<label class="search">${SEARCH_SVG}<input type="search" id="q" autocomplete="off" enterkeyhint="search"></label>
<div class="list" id="list"></div><p class="note" id="shNote"></p></div></div>
<div class="sheet pop" id="fb" hidden><div class="panel" role="dialog" aria-modal="true" aria-labelledby="fbTitle"><h3 id="fbTitle">${S.fbTitle}</h3>
<textarea id="fbText" maxlength="2000" placeholder="${S.fbPh}" aria-label="${S.fbTitle}"></textarea><p class="note" id="fbNote">${S.fbNote}</p>
<div class="fbrow"><button type="button" class="act" data-act="fbclose">${S.fbCancel}</button><button type="button" class="donebtn" data-act="fbsend">${S.fbSend}</button></div></div></div>
<div class="sheet pop" id="bye" hidden><div class="panel" role="alertdialog" aria-modal="true" aria-labelledby="byeTitle" aria-describedby="byeText"><h3 id="byeTitle">${S.byeTitle}</h3><p class="byet" id="byeText">${fillP(S.byeText)}</p>
<div class="fbrow"><button type="button" class="act" data-act="byeclose">${S.fbCancel}</button><button type="button" class="act kill" data-act="byego">${S.byeGo}</button></div></div></div>`, { bare: true, poll: `const S=${JSON.stringify(S)};const P=${JSON.stringify(PRODUCT_NAME)};const ID=${JSON.stringify(t.id)};let st=${JSON.stringify(view).replace(/</g, '\\u003c')};\n${SETTINGS_JS}` });
  }
  const settingsDoor = (res) => {
    const how = `Write <b>settings</b> in the ${esc(PRODUCT_NAME)} group we made for you in WhatsApp, and open the link it sends back.`;
    return small(res, ['Open this page from WhatsApp', how], [HE.door[0], HE.door[1].split('{p}').join(esc(PRODUCT_NAME))]);
  };
  // A browser without a session waits here with a code; the owner sends it in their control group (door.js).
  // The button opens WhatsApp with the code typed in, to pick the group from the chats. Not the group's own
  // invite link: this page is open to anyone with the address, and that link would let them join.
  const codePage = (res, t, code) => {
    const he = isHe(res), p = esc(PRODUCT_NAME), C = HE.code;
    const title = (he ? C.title : 'Send this code in your <b>{p}</b> group').split('{p}').join(p);
    return page(res, `${PRODUCT_NAME} · ${he ? C.tab : 'Code'}`, `<style nonce="${res.locals.nonce}">.go{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:999px;background:var(--green);color:var(--ink);font-weight:600;font-size:17px;text-decoration:none;margin:16px 0 10px}</style>
<h1 class="small">${title}</h1>
<div class="code">${code}</div>
<a class="go" href="https://wa.me/?text=${code}">${he ? C.go : 'Send in WhatsApp'}</a>
<p class="muted">${(he ? C.note : 'Pick the {p} group. This page opens by itself.').split('{p}').join(p)}</p>`, { poll: `
async function ask(){try{const r=await fetch('/api/settings/${t.id}/door',{credentials:'same-origin'});if((await r.json()).state!=='waiting'){location.reload();return;}}catch(e){}setTimeout(ask,2000);}
setTimeout(ask,2000);` });
  };
  app.get('/settings/:id', (req, res) => {
    // A link from before sessions carried a token (?t=); the address alone is the link now.
    if (req.query.t != null && ID_RE.test(req.params.id)) return res.redirect(303, `/settings/${req.params.id}${req.query.w === '1' ? '?welcome=1' : ''}`);
    let t = signedIn(req);
    if (!t) {
      const a = accountOf(req);
      // Not an account that has a control group to send the code in: how to get here, nothing more.
      if (!a?.linkedAt || !a.target?.jid) return res.status(404).type('html').send(settingsDoor(res));
      // The code arrived while the waiting page was away (a phone pauses it in the background), and the
      // owner came back by the link in the reply: this browser is let in here.
      const rd = cookies(req).rd, open = DOOR_RE.test(rd || '') ? doorState(a, rd) : null;
      if (!open?.token) {
        const d = openDoor(a, rd, deviceOf(String(req.get('user-agent') || '')));
        res.append('Set-Cookie', `rd=${d.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${req.secure ? '; Secure' : ''}`);
        return res.type('html').send(codePage(res, a, d.code));
      }
      setSession(req, res, a, open.token); res.append('Set-Cookie', `rd=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
      t = a;
    }
    if (!t.linkedAt) return res.redirect(303, `/link/${t.id}`);
    t.noteSettingsVisit();
    res.type('html').send(settingsPage(req, res, t, { welcome: req.query.welcome === '1' }));
  });
  // The waiting page asks here whether its code arrived; when it has, this answer carries the session.
  app.get('/api/settings/:id/door', (req, res) => {
    const t = accountOf(req), id = cookies(req).rd;
    const d = t && DOOR_RE.test(id || '') ? doorState(t, id) : { state: 'gone' };
    if (d.token) { setSession(req, res, t, d.token); res.append('Set-Cookie', `rd=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`); }
    res.json({ state: d.state });
  });
  app.get('/api/settings/:id', (req, res) => { const t = auth(req, res); if (t) res.json(t.settingsView()); });
  app.post('/api/settings/:id', express.json({ limit: '32kb' }), async (req, res) => {
    const t = auth(req, res); if (!t) return;
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'bad request' });
    res.json(await t.updateSettings(req.body));
  });
  app.post('/api/settings/:id/feedback', express.json({ limit: '16kb' }), (req, res) => {
    const t = auth(req, res); if (!t) return;
    const r = t.addFeedback(req.body?.text);
    res.status(r === 'ok' ? 200 : r === 'empty' ? 400 : 429).json({ result: r });
  });
  app.get('/api/settings/:id/chats', async (req, res) => {
    const t = auth(req, res); if (!t) return;
    res.json({ rows: await t.settingsDirectory(req.query.kind === 'groups' ? 'groups' : 'chats') });
  });
  app.get('/api/settings/:id/number', async (req, res) => { const t = auth(req, res); if (t) res.json({ row: await t.settingsNumber(req.query.q) }); });
  app.get('/api/settings/:id/group-link', async (req, res) => { const t = auth(req, res); if (t) res.json({ groupLink: await t.groupLink() }); });

  // ---------- admin (health only; support endpoints below) ----------
  function adminAuth(req, res, next) {
    res.locals.lang = 'en'; // the admin pages are English and left to right, whatever the site language
    if (!ADMIN_PASSWORD) return res.status(404).end();
    if (adminFailLimiter.blocked(req.ip)) return res.status(429).type('text').send('Too many failed attempts. Try again later.');
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    let ok = false;
    if (scheme === 'Basic' && b64) {
      // Compared as hashes, so neither the time taken nor a length says how close a guess came;
      // both are always checked, so a failure never says which one was wrong.
      const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
      const [user, ...rest] = Buffer.from(b64, 'base64').toString('utf8').split(':');
      const passOk = same(rest.join(':'), ADMIN_PASSWORD), userOk = same(user, ADMIN_USER || user);
      ok = passOk && userOk;
    }
    if (ok) { const v = cookies(req).rv; if (visitors.VISITOR_RE.test(v || '')) visitors.markStaff(v); return next(); }
    adminFailLimiter.hit(req.ip);
    console.warn(`🔐 admin sign-in failed from ${req.ip} (${String(req.get('x-forwarded-for') || '').split(',').length} forwarded hop(s))`);
    res.set('WWW-Authenticate', `Basic realm="${PRODUCT_NAME} admin"`); res.status(401).send('Authentication required');
  }
  const overview = () => {
    const ts = registry.list().map((t) => ({ ...t.status({ history: true }), signup: registry.signupOf(t), expiresAt: t.linkedAt ? null : t.createdAt + registry.UNLINKED_TTL_MIN * 60e3 }));
    return {
      product: PRODUCT_NAME, accounts: ts.length, connected: ts.filter((t) => t.ready).length,
      pending: registry.pendingCount(), maxPending: registry.MAX_PENDING, max: registry.MAX_TENANTS, dataMounted: dataDirIsMount(), health: health.snapshot(),
      budget: { serverMinutesToday: Math.round(secondsToday() / 60), serverDailyMinutes: GLOBAL_DAILY_MINUTES || null, perAccountDailyMinutes: DAILY_MINUTES_CAP || null },
      tenants: ts,
      feedback: registry.list().flatMap((t) => (t.feedback || []).map((f) => ({ ...f, account: t.id, name: t.waName || t.label, phone: t.phone }))).sort((a, b) => b.at - a.at),
      feedbackSeenAt: feedbackSeen(),
    };
  };
  // When the operator last opened the admin page: feedback after it is new.
  const SEEN_FILE = dataPath('feedback-seen.json');
  const feedbackSeen = () => { try { return Number(JSON.parse(readFileSync(SEEN_FILE, 'utf8')).at) || 0; } catch { return 0; } };
  app.get('/admin.json', adminAuth, (_req, res) => res.json(overview()));
  // The transcription experiment (experiments.js): per arm and per segment, counts and rates only.
  const AB = brain.info().experiment || { shares: { B: 0, C: 0 }, maxSeconds: 0 };
  const abDays = (req) => Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  app.get('/admin/ab.json', adminAuth, (req, res) => { const recs = experiments.readRecords({ days: abDays(req) }); res.json({ days: abDays(req), shares: { B: AB.shares.B, C: AB.shares.C }, maxSeconds: AB.maxSeconds, rows: experiments.summarize(recs), voiceFix: experiments.summarizeVoiceFix(recs) }); });
  app.get('/admin/ab', adminAuth, (req, res) => {
    const days = abDays(req), recs = experiments.readRecords({ days }), rows = experiments.summarize(recs), vf = experiments.summarizeVoiceFix(recs);
    const cols = [['n', 'recordings'], ['minutes', 'minutes'], ['fellBack', 'fell back to A ‰'], ['gateDrop', 'dropped ‰'], ['retried', 'retried ‰'], ['rewriteRejected', 'fix rejected ‰'], ['deltaMedian', 'fix delta (median)'], ['deltaOver10', 'delta>0.1 ‰'], ['wpsMedian', 'words/s'], ['sttP50', 'stt p50 s'], ['sttP90', 'stt p90 s'], ['totalP50', 'total p50 s'], ['usdPerMin', '$/min'], ['reactions', 'reactions ‰'], ['revokes', 'deleted ‰'], ['replies', 'replies ‰'], ['rerecorded', 're-recorded within 60s ‰'], ['corrected', 'corrected by the speaker ‰'], ['rerecordGapMedian', 'median gap s']];
    const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(v < 1 ? 3 : 1)) : esc(String(v)));
    const segments = [...new Set(rows.map((r) => r.segment))];
    const table = segments.map((seg) => `<h3>${esc(seg)}</h3><table class="ab"><tr><th>arm</th>${cols.map(([, h]) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.filter((r) => r.segment === seg).map((r) => `<tr><td><b>${esc(r.arm)}</b></td>${cols.map(([k]) => `<td>${fmt(r[k])}</td>`).join('')}</tr>`).join('')}</table>`).join('');
    const body = `<h1>Transcription experiment</h1><p class="muted">Last ${days} days · shares B ${Math.round(AB.shares.B * 100)}% C ${Math.round(AB.shares.C * 100)}%${AB.maxSeconds ? ` · up to ${AB.maxSeconds}s` : ''} · ‰ = per 1,000 recordings in the arm. Periods: ${[1, 2, 7, 30].map((d) => `<a href="/admin/ab?days=${d}">${d}d</a>`).join(' · ')}</p>
<h3>Corrections by voice</h3><p>${vf.replies ? `${vf.replies} spoken repl${vf.replies === 1 ? 'y' : 'ies'} to a transcript · <b>${vf.fixed} corrected</b> (${vf.own} own, ${vf.others} others', ${vf.accounts} account${vf.accounts === 1 ? '' : 's'}) · ${vf.notACorrection} not a correction · ${vf.editFailed} edit failed<br><span class="muted">wrong at: recognition ${vf.recognition} · clean-up ${vf.cleanup} · median ${vf.gapMedian ?? '–'}s after the text · median ${vf.wordsChangedMedian ?? '–'} word(s) changed</span>` : '<span class="muted">none yet</span>'}</p>
<style>table.ab{border-collapse:collapse;font-size:13px;margin:6px 0 18px}table.ab th,table.ab td{border:1px solid var(--line);padding:4px 8px;text-align:right}table.ab th{font-weight:500;color:var(--mute)}</style>${table || '<p>No records yet.</p>'}`;
    res.type('html').send(page(res, `${PRODUCT_NAME} · experiment`, body, { wide: true, nav: '<a class="navlink" href="/admin">Admin</a> <a class="navlink" href="/admin/ab.json">JSON</a>' }));
  });
  // Support: (re)create an account's control group — e.g. the user deleted it.
  // ?test=1 only proves group creation works on this account (creates "<name> (test)"
  // and leaves it again) without touching the real control group. Runs in the
  // background; poll GET /admin/control-group/:id/test for the outcome.
  app.post('/admin/control-group/:id', adminAuth, async (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    if (!t.ready || !t.sock) return res.status(409).json({ error: 'account not connected' });
    if (req.query.test === '1') {
      const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
      t.groupTest = { startedAt: Date.now(), state: 'running' };
      (async () => {
        try {
          const g = await withTimeout(t.sock.groupCreate(`${PRODUCT_NAME} (test)`, []), 45000, 'groupCreate');
          let left = false;
          try { await withTimeout(t.sock.groupLeave(g.id), 20000, 'groupLeave'); left = true; } catch { /* reported below */ }
          t.groupTest = { ...t.groupTest, state: 'ok', participants: (g.participants || []).length, leftAgain: left, ms: Date.now() - t.groupTest.startedAt };
        } catch (e) {
          t.groupTest = { ...t.groupTest, state: 'failed', error: String(e?.message || e).split('\n')[0], ms: Date.now() - t.groupTest.startedAt };
        }
      })();
      return res.status(202).json({ started: true });
    }
    if (t.target && req.query.force !== '1') return res.status(409).json({ error: 'account already has a control group; add ?force=1 to create another' });
    await t.createControlGroup();
    res.json(t.status());
  });
  app.get('/admin/control-group/:id/test', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    res.json(t.groupTest || { state: 'never run' });
  });
  // Support: which transcription provider an account uses — "free" (cheap model)
  // or "pro" (the better one). POST /admin/plan/<id>?plan=pro
  app.post('/admin/plan/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const plan = String(req.query.plan || req.body?.plan || '');
    if (!t.setPlan(plan)) return res.status(400).json({ error: `plan must be one of ${PLANS.join(', ')}` });
    res.json({ id: t.id, plan: t.plan, model: planLabel(t.plan) });
  });
  // Support: set an account's transcription language ('' = auto-detect), e.g. to
  // release an account that an older version locked to one language.
  // POST /admin/language/<id>?code=he   (empty = auto)
  app.post('/admin/language/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const code = String(req.query.code ?? req.body?.code ?? '');
    if (!LANGUAGES.some(([v]) => v === code)) return res.status(400).json({ error: `code must be one of ${LANGUAGES.map(([v]) => v || "''").join(', ')}` });
    t.setLanguage(code);
    res.json({ id: t.id, language: t.language || 'auto' });
  });
  // Support: also transcribe this account's recordings with other models, to
  // compare them on real audio. Up to four, comma-separated; the readings are
  // posted into the owner's own control group, never logged.
  // POST /admin/ab/<id>?model=gpt-4o-transcribe,whisper-large-v3-turbo   (empty = off)
  app.post('/admin/ab/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const raw = String(req.query.model ?? req.body?.model ?? '');
    if (raw && !/^[\w.,/-]{1,120}$/.test(raw)) return res.status(400).json({ error: 'model names may contain letters, digits, dot, dash, slash and commas' });
    t.setAbModel(raw);
    res.json({ id: t.id, abModels: t.abModel ? t.abModel.split(',').map((s) => s.trim()).filter(Boolean) : [] });
  });
  // Opt-in, per account, not in the user-facing UI: keep this account's recordings
  // (with what the models made of them) to improve the product.
  // POST /admin/keep-audio/<id>?on=1|0
  // Support: this account's own daily limit, in minutes (empty or 0 = the server's default).
  // POST /admin/cap/<id>?minutes=60
  app.post('/admin/cap/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const raw = String(req.query.minutes ?? req.body?.minutes ?? '').trim();
    if (raw && !/^\d{1,4}$/.test(raw)) return res.status(400).json({ error: 'minutes must be a whole number (0 or empty = default)' });
    t.setCapMinutes(Number(raw || 0));
    res.json({ id: t.id, capMinutes: t.capMinutes || null, dailyMinutes: t.dailyCapMinutes() });
  });
  // Admin only, not in the user's settings: this account's videos are transcribed too (off by default).
  // POST /admin/video/<id>?on=1|0
  // A pilot, admin only: a spoken reply to one of this account's transcripts, from its speaker, corrects it.
  // POST /admin/voice-fix/<id>?on=1|0
  app.post('/admin/voice-fix/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const on = /^(1|true|on|yes)$/i.test(String(req.query.on ?? req.body?.on ?? ''));
    res.json({ id: t.id, voiceFix: t.setVoiceFix(on) });
  });
  app.post('/admin/video/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const on = /^(1|true|on|yes)$/i.test(String(req.query.on ?? req.body?.on ?? ''));
    res.json({ id: t.id, transcribeVideo: t.setTranscribeVideo(on) });
  });
  app.post('/admin/keep-audio/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const on = /^(1|true|on|yes)$/i.test(String(req.query.on ?? req.body?.on ?? ''));
    t.setKeepAudio(on);
    res.json({ id: t.id, keepAudio: t.keepAudio, keepDays: research.RESEARCH_KEEP_DAYS, maxMb: research.RESEARCH_MAX_MB });
  });
  // What is kept for one account: metadata and the transcripts, newest first.
  app.get('/admin/research/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    res.json({ id: t.id, keepAudio: t.keepAudio, usage: research.usage(), items: research.list(t.id).slice(0, Number(req.query.limit) || 50) });
  });
  // One kept recording, as audio. Admin only, and only ever for an account that opted in.
  app.get('/admin/research/:id/:item', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const p = research.audioPath(t.id, String(req.params.item));
    if (!p) return res.status(404).json({ error: 'no such recording' });
    res.sendFile(p);
  });
  // Support: hand an owner who lost their private link a fresh one (the old one stops working).
  // Before a deploy: close the door to new sign-ups and report when no one is halfway through linking.
  // POST /admin/drain?on=1 closes it, ?on=0 opens it; GET /admin/drain says whether it is safe to restart.
  // Someone is "in the middle" while their link page is still asking (a QR or a pairing code on screen),
  // and for a few minutes after their phone linked, until its first sync is through.
  const DRAIN_VIEW_MS = 30e3, DRAIN_FRESH_MS = 5 * 60e3;
  const drainState = () => {
    const now = Date.now(), ts = registry.list();
    const viewing = ts.filter((t) => !t.linkedAt && now - (t.lastViewedAt || 0) < DRAIN_VIEW_MS).length;
    const justLinked = ts.filter((t) => t.linkedAt && now - t.linkedAt < DRAIN_FRESH_MS).length;
    return { draining: health.isDraining(), viewing, justLinked, ready: health.isDraining() && viewing === 0 && justLinked === 0 };
  };
  app.get('/admin/drain', adminAuth, (_req, res) => res.json(drainState()));

  // Notes from us to accounts, in their control group, in their language (Tenant.sendNote): sent from here,
  // no deploy needed. POST /admin/announce with JSON:
  //   name        what the note is called; each account gets a named note once (a-z, 0-9, dash)
  //   he, en      the text in each language; {link} {invite} {name} {week_minutes} {total_notes} {total_minutes}
  //               are filled in per account
  //   image       optional picture, base64 (jpeg or png); the text becomes its caption
  //   audience    optional: linkedBefore / linkedAfter (dates), activeDays (audio transcribed on one of the last
  //               N days, from the usage kept on disk), atLeast ({ week_minutes: 1 }: only accounts whose number
  //               would be at least that; week_minutes, total_notes, total_minutes), lang ('he' | 'en'),
  //               ids (a list of account ids)
  // and one of: nothing (a dry run: who would get it), to: "<id>" (a test to that account, not recorded,
  // repeatable), go: true (send to everyone in the audience, one every few seconds), stop: true.
  // GET /admin/announce: the progress of the current or last send; the admin page shows it with a stop button.
  const ANNOUNCE_GAP_MS = Number(process.env.ANNOUNCE_GAP_MS ?? 6000);
  let announcing = null; // { name, total, sent, skipped, failed, startedAt, done, stop, ... }
  const NOTE_COUNTS = ['week_minutes', 'total_notes', 'total_minutes'];
  const audienceOf = (noteName, a = {}) => {
    const after = Date.parse(a.linkedAfter), before = Date.parse(a.linkedBefore), days = Number(a.activeDays), ids = Array.isArray(a.ids) ? new Set(a.ids.map(String)) : null;
    const least = Object.entries(a.atLeast || {});
    return registry.list().filter((t) => t.linkedAt && t.target?.jid && !t.target.announced?.includes(noteName)
      && (!Number.isFinite(after) || t.linkedAt >= after) && (!Number.isFinite(before) || t.linkedAt < before)
      && (!(days > 0) || t.transcribedWithin(days))
      && (!a.lang || (t.ownerLocale() === 'he') === (a.lang === 'he')) && (!ids || ids.has(t.id))
      && (!least.length || ((v) => least.every(([k, n]) => Number(v[k]) >= Number(n)))(t.noteValues())));
  };
  const stopAnnouncing = () => { if (announcing && !announcing.done) announcing.stop = true; return announcing || { running: false }; };
  app.get('/admin/announce', adminAuth, (_req, res) => res.json(announcing || { running: false }));
  app.post('/admin/announce/stop', adminAuth, (_req, res) => { stopAnnouncing(); res.redirect(303, '/admin'); }); // the admin page's button
  app.post('/admin/announce', adminAuth, express.json({ limit: '3mb' }), async (req, res) => {
    const b = req.body || {};
    if (b.stop) return res.json(stopAnnouncing());
    // description: true sets the control groups' description instead of posting (no message, no dot), and
    // keeps the text for groups created from now on. An account whose description is already that is skipped.
    const describe = b.description === true;
    const noteName = describe ? 'description' : String(b.name || ''), texts = { he: String(b.he || ''), en: String(b.en || '') };
    if (!/^[a-z0-9-]{1,40}$/.test(noteName)) return res.status(400).json({ error: 'name: a-z, 0-9, dash, up to 40' });
    if (!texts.he || !texts.en || texts.he.length > 1500 || texts.en.length > 1500) return res.status(400).json({ error: 'he and en texts, up to 1500 characters each' });
    if (b.image) {
      const img = Buffer.from(String(b.image), 'base64');
      const jpeg = img[0] === 0xff && img[1] === 0xd8, png = img.subarray(0, 4).toString('hex') === '89504e47';
      if (!jpeg && !png) return res.status(400).json({ error: 'image: base64 of a jpeg or png' });
      texts.image = img;
    }
    if (b.to) {
      const t = registry.get(String(b.to));
      if (!t) return res.status(404).json({ error: 'no such account' });
      return res.json({ to: t.id, result: describe ? await t.setControlDescription(texts) : await t.sendNote(noteName, texts, { force: true }) });
    }
    const bad = Object.keys(b.audience?.atLeast || {}).find((k) => !NOTE_COUNTS.includes(k));
    if (bad) return res.status(400).json({ error: `atLeast: one of ${NOTE_COUNTS.join(', ')}` });
    const targets = describe ? audienceOf('', b.audience || {}).filter((t) => t.target.description !== (t.ownerLocale() === 'he' ? texts.he : texts.en)) : audienceOf(noteName, b.audience || {});
    const online = targets.filter((t) => t.ready), he = online.filter((t) => t.ownerLocale() === 'he').length;
    const plan = { name: noteName, audience: { ...b.audience, ...(Array.isArray(b.audience?.ids) ? { ids: b.audience.ids.length } : {}) }, image: !!texts.image, eligible: targets.length, online: online.length, he, en: online.length - he, offline: targets.length - online.length };
    if (!b.go) return res.json({ dryRun: true, ...plan });
    if (announcing && !announcing.done) return res.status(409).json({ error: 'a send is already running', progress: announcing });
    if (describe) try { writeFileSync(dataPath('control-description.json'), JSON.stringify({ he: texts.he, en: texts.en })); } catch (e) { return res.status(500).json({ error: e.message }); }
    announcing = { ...plan, total: online.length, sent: 0, skipped: 0, failed: 0, startedAt: Date.now(), done: false, stop: false };
    console.log(`📣 note "${noteName}": sending to ${online.length} accounts, one every ${ANNOUNCE_GAP_MS / 1000}s`);
    (async () => {
      for (const t of online) {
        if (announcing.stop) break;
        try { const r = describe ? await t.setControlDescription(texts) : await t.sendNote(noteName, texts); if (r.startsWith('sent') || r === 'set') announcing.sent++; else announcing.skipped++; }
        catch (e) { announcing.failed++; console.warn(`${t.tag} 📣 note failed: ${String(e?.message || e).slice(0, 80)}`); }
        await new Promise((r) => setTimeout(r, ANNOUNCE_GAP_MS));
      }
      announcing.done = true; announcing.endedAt = Date.now();
      console.log(`📣 note "${noteName}": done (${announcing.sent} sent, ${announcing.skipped} skipped, ${announcing.failed} failed${announcing.stop ? ', stopped' : ''})`);
    })();
    res.status(202).json(announcing);
  });
  // Server-wide switches (features.js): on for every account, kept on disk, no deploy and no restart.
  const FEATURE_LABELS = { voiceFixAll: ['Corrections by voice', 'a spoken reply to a transcript fixes it'], videosAll: ['Videos', 'transcribed like voice notes'] };
  const SETTING_LABELS = { transcribedReaction: ['Mark on a transcribed recording', 'only where the text is posted in the chat'], fixReaction: ['Mark on a spoken correction', 'once the transcript is edited'] };
  const featuresPanel = () => {
    const f = features(), v = settings();
    const marks = Object.keys(SETTINGS).map((k) => `<form data-op action="/admin/settings/${k}" data-reload="1"><div class="f"><label>${esc(SETTING_LABELS[k][0])}</label><input type="text" name="value" value="${esc(v[k])}" placeholder="none" maxlength="32" style="max-width:5em"><p class="muted">${esc(SETTING_LABELS[k][1])} · one emoji, empty for none · default ${esc(SETTINGS[k])}</p></div><button class="btn">Set</button></form>`).join('');
    return `<h2 class="sect">For every account</h2><div class="card ops">${marks}${FEATURES.map((k) => `<form data-op action="/admin/features/${k}" data-reload="1"${f[k] ? '' : ` data-confirm="Turn ${esc(FEATURE_LABELS[k][0].toLowerCase())} on for every account?"`}><input type="hidden" name="on" value="${f[k] ? '0' : '1'}"><div class="f"><label>${esc(FEATURE_LABELS[k][0])}</label><p class="muted">${f[k] ? `<b>On for every account</b> · ${esc(FEATURE_LABELS[k][1])}` : 'Off · only accounts turned on one by one'}</p></div><button class="btn">${f[k] ? 'Turn off' : 'Turn on for all'}</button></form>`).join('')}</div>`;
  };
  // POST /admin/settings/<key>?value=<emoji>   (empty = none)
  app.post('/admin/settings/:key', adminAuth, (req, res) => {
    const key = String(req.params.key);
    if (!(key in SETTINGS)) return res.status(404).json({ error: `no such setting; one of ${Object.keys(SETTINGS).join(', ')}` });
    try { res.json(setSetting(key, req.query.value ?? req.body?.value ?? '')); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  // POST /admin/features/<name>?on=1|0
  app.post('/admin/features/:name', adminAuth, (req, res) => {
    const name = String(req.params.name);
    if (!FEATURES.includes(name)) return res.status(404).json({ error: `no such feature; one of ${FEATURES.join(', ')}` });
    const on = /^(1|true|on|yes)$/i.test(String(req.query.on ?? req.body?.on ?? ''));
    res.json(setFeature(name, on));
  });
  const notesPanel = () => {
    if (!announcing) return '';
    const a = announcing, state = a.done ? (a.stop ? 'stopped' : 'done') : 'sending';
    return `<h2 class="sect">Note to accounts</h2><div class="card"><p><b>${esc(a.name)}</b> · ${state} · ${a.sent} of ${a.total} sent${a.skipped ? ` · ${a.skipped} skipped` : ''}${a.failed ? ` · <span class="danger">${a.failed} failed</span>` : ''} · ${a.he} Hebrew, ${a.en} English${a.offline ? ` · ${a.offline} offline, not sent` : ''}</p>${a.done ? '' : '<form method="post" action="/admin/announce/stop"><button class="btn" type="submit">Stop sending</button></form>'}</div>`;
  };
  app.post('/admin/drain', adminAuth, (req, res) => {
    const on = /^(1|true|on|yes)$/i.test(String(req.query.on ?? req.body?.on ?? ''));
    health.setDraining(on);
    console.log(`🚪 sign-ups ${on ? 'closed for a deploy' : 'open again'}`);
    res.json(drainState());
  });

  // Support: the owner's phone shows "waiting for this message" under our posts (its encryption session
  // with us went out of step). Forget our sessions with the owner's own devices; the next post opens fresh ones.
  // POST /admin/sessions/<id>/reset
  app.post('/admin/sessions/:id/reset', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    try { res.json({ id: t.id, forgotten: t.resetOwnSessions() }); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });

  app.post('/admin/link/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    // Every browser of the account is signed out; the link signs one in, for a day.
    res.json({ id: t.id, label: t.label, link: `${req.protocol}://${req.get('host')}/link/${t.id}?k=${issueEntry(t)}` });
  });
  app.get('/admin', adminAuth, (req, res) => {
    const o = { ...overview(), notesHtml: notesPanel() + featuresPanel() };
    try { writeFileSync(SEEN_FILE, JSON.stringify({ at: Date.now() })); } catch { /* the marks just stay */ }
    res.type('html').send(page(res, `${PRODUCT_NAME} · admin`, adminPage(o, res.locals.nonce, {
      days: FUNNEL_PERIODS.some(([d]) => String(d) === req.query.days) ? Number(req.query.days) : 30,
      sort: ACCOUNT_SORTS.some(([k]) => k === req.query.sort) ? req.query.sort : 'recent',
      f: ACCOUNT_FILTERS.some(([k]) => k === req.query.f) ? req.query.f : 'all',
      q: String(req.query.q || '').slice(0, 80), page: Math.max(1, parseInt(req.query.page, 10) || 1),
    }), { wide: true, nav: '<a class="navlink" href="/admin.json">JSON</a>', poll: ADMIN_JS }));
  });

  // One account, in full: everything on its card and the support tools.
  app.get('/admin/a/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).type('html').send(page(res, 'No such account', '<div class="wrap adm"><h1 class="small">No such account</h1><p>It may have left or expired.</p><a class="back2" href="/admin#accounts">← All accounts</a></div>', { wide: true }));
    const one = (x) => ({ ...x.status({ history: true }), signup: registry.signupOf(x), expiresAt: x.linkedAt ? null : x.createdAt + registry.UNLINKED_TTL_MIN * 60e3 });
    const me = one(t), all = registry.list();
    const byCode = new Map(all.map((x) => [x.inviteCode, x])), byId = new Map(all.map((x) => [x.id, x]));
    const others = me.signup?.visitor && !me.linkedAt ? all.filter((x) => x.id !== t.id && !x.linkedAt && registry.signupOf(x)?.visitor === me.signup.visitor).map(one) : [];
    res.type('html').send(page(res, `${me.waName || me.id.slice(0, 8)} · admin`, `${nonceStyle(res.locals.nonce, ADMIN_CSS)}<div class="wrap adm"><a class="back2" href="/admin#accounts">← All accounts</a>${me.linkedAt ? adminCard(me, byCode, measuredRate(all), byId) : pendingCard(me, byId, others)}</div>`, { wide: true, nav: '<a class="navlink" href="/admin">Admin</a>', poll: ADMIN_JS }));
  });

  // Liveness only. Counts and details are behind the admin password.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  // Which code this is: the public repository's commit this image was built from, and the
  // brain's, as scripts/deploy.sh wrote them into build-info.json before uploading. Anyone can
  // put the shell commit next to github.com/tomer-van-cohen/ramble. Nothing else is in it.
  app.get('/version', (_req, res) => res.json(buildInfo()));
  return app;
}
