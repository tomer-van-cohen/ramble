/**
 * One linked WhatsApp account: its connection, its settings, its transcription
 * pipeline and its control group. Everything here is per account; nothing is
 * shared between tenants except the model providers.
 *
 * What a tenant does (and nothing else):
 *   - the owner's own voice notes → text posted under each, in every chat
 *   - voice notes people send in private chats → text under them (videos too, where an admin turned them on)
 *   - groups: off until switched on (forward a note into the control group,
 *     reply "on"); then text under each recording, inside the group
 *   - the control group: created automatically on first link; on/off replies,
 *     "delete" to remove any post of ours, "names: …" to teach names
 *   - dictated messages: a voice note recorded in the control group saying
 *     "send Eden that I'm on my way" is matched to a contact and proposed; it is
 *     texted to Eden, as the owner, only after the owner replies yes
 */
import QRCode from 'qrcode';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { createLink } from './wa.js';
import { saveMedia, deleteMediaFile, sweepMediaDir, MAX_MEDIA_SECONDS } from './media.js';
import { createSemaphore } from './semaphore.js';
import { brain } from './brain/index.js';
import { measureSeconds, prepareAudio } from './audio.js';
import * as budget from './budget.js';
import * as experiments from './experiments.js';
import * as usage from './usage.js';
import { experimentOn } from './experiments.js';
import { createGlossary } from './glossary.js';
import * as research from './research.js';
import * as claims from './claims.js';
import { feature, setting } from './features.js';
import { noteError } from './health.js';
import { dataPath } from './paths.js';
import { profileOnce } from './profile.js';
import { normalizePhone } from './pairing.js';
import { LOGO_MARK_SVG } from './logo.js';
import { matchContacts, norm as normName } from './contacts.js';
import { meter, bill } from './cost.js';
import { readSettings, applyPatch, decide, whereOf, groupsMode, setGroupsMode, legacyGroups, settingsUrl, SITE_URL } from './settings.js';
import { readSessions, answerDoor } from './door.js';
import { netWhy } from './net.js';

// Bounded work: at most this many recordings in flight per account, and across
// the whole process, so one flooded account can't starve the others or the box.
const PER_ACCOUNT_CONCURRENCY = Number(process.env.PER_ACCOUNT_CONCURRENCY ?? 2) || 2;
const GLOBAL_CONCURRENCY = Number(process.env.GLOBAL_CONCURRENCY ?? 8) || 8;
const MAX_QUEUE = Number(process.env.MAX_QUEUE_PER_ACCOUNT ?? 20) || 20; // waiting jobs per account beyond the running ones
// A text under a recording makes sense only right after it. A recording this old when it reaches us (the
// server was down, or a backlog held it) is left alone: a text popping up minutes later, out of context,
// is a disturbance, not a help. 0 = no limit. The control group is exempt: a forward there is asked for.
export const MAX_RECORDING_AGE_MS = Number(process.env.MAX_RECORDING_AGE_MS ?? 60e3);
const globalSlots = createSemaphore(GLOBAL_CONCURRENCY);

export const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Ramble';
const OWNER_LABEL = 'me';
// The languages an owner can pin, by code: set with "language <name>" in the control group ('' = auto-detect).
export const LANGUAGES = [['', 'auto', 'Auto-detect', 'זיהוי אוטומטי'], ['he', 'hebrew', 'Hebrew', 'עברית'], ['en', 'english', 'English', 'אנגלית'], ['ar', 'arabic', 'Arabic', 'ערבית'], ['ru', 'russian', 'Russian', 'רוסית'], ['es', 'spanish', 'Spanish', 'ספרדית'], ['fr', 'french', 'French', 'צרפתית'], ['de', 'german', 'German', 'גרמנית'], ['pt', 'portuguese', 'Portuguese', 'פורטוגזית'], ['it', 'italian', 'Italian', 'איטלקית']];
/** "hebrew", "Hebrew", "he", "auto" → its row; anything else → null. */
export const findLanguage = (word) => { const w = String(word || '').trim().toLowerCase(); return LANGUAGES.find(([code, name]) => w === name || (code && w === code)) || null; };
// Every command is ONE English word — include, exclude, delete, yes, no, undo, leave, help, names —
// so there is never a question of which one to write. No synonyms, no translations.
const TARGET_KEYWORD = '#transcribe'; // manual fallback for arming the control group
const PENDING_LEAVE_TTL_MS = 10 * 60e3;
// A spoken answer is speech, not a typed command: "Yes." / "כן" / "שתיים" — punctuation off,
// a Hebrew yes/no and number words brought to the one word a typed answer would be.
const SPOKEN_WORDS = new Map([['כן', 'yes'], ['לא', 'no'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'], ['six', '6'], ['אחד', '1'], ['אחת', '1'], ['שתיים', '2'], ['שניים', '2'], ['שתים', '2'], ['שלוש', '3'], ['ארבע', '4'], ['חמש', '5'], ['שש', '6']]);
export const spokenAnswer = (text) => { const w = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim(); return SPOKEN_WORDS.get(w) || w; };
// Both sides of a chat may be accounts here. The sender's account posts the text; the
// recipient's gives it this head start, then waits for the outcome before stepping in.
const YIELD_MS = Number(process.env.CLAIM_YIELD_MS ?? 1500);
// A message within this long of the previous one from the same account is paced (1–3 s).
const SEND_PACE_WINDOW_MS = Number(process.env.SEND_PACE_WINDOW_MS ?? 5000);
const CLAIM_WAIT_MS = Number(process.env.CLAIM_WAIT_MS ?? 180e3);
const PENDING_SEND_TTL_MS = 10 * 60e3; // how long "reply with the number" stays open
const PENDING_SWITCH_TTL_MS = 10 * 60e3; // how long an include/exclude question stays open
// Videos are transcribed only for accounts an admin turned them on for (transcribeVideo), or for
// everyone with TRANSCRIBE_VIDEO=1. Voice notes are what people sign up for; a video's text is noise to most.
export const TRANSCRIBE_VIDEO = process.env.TRANSCRIBE_VIDEO === '1';
// How long after our transcript a spoken reply may still correct it: WhatsApp allows an edit for 15 minutes.
// WhatsApp ignores an edit sent more than 15 minutes after the message, and transcribing a spoken
// correction and asking the model take time: 12 minutes leaves room, and the edit is checked again.
const FIX_WINDOW_MS = Number(process.env.FIX_WINDOW_MS ?? 12 * 60e3);
const FIX_TYPED_MAX_WORDS = 30; // a typed correction is short; a longer text reply is a message, not a fix
const TRANSCRIBE_MIN_SECONDS = Number(process.env.TRANSCRIBE_MIN_SECONDS ?? 1) || 0;
// A single recording longer than this is not transcribed: one forwarded lecture
// would otherwise eat a whole day's quota (and the matching bill) at once.
export const MAX_TRANSCRIBE_SECONDS = Number(process.env.MAX_TRANSCRIBE_SECONDS ?? 600) || 0;
export const DAILY_MINUTES_CAP = Number(process.env.DAILY_MINUTES_CAP ?? 30) || 0;
// Invite a friend, get more minutes a day. No codes to type: the friend opens
// your link, scans, and the moment their WhatsApp is linked you are credited.
export const INVITE_BONUS_MINUTES = Number(process.env.INVITE_BONUS_MINUTES ?? 10) || 0;
export const INVITE_BONUS_MAX = Number(process.env.INVITE_BONUS_MAX ?? 60) || 0; // per account, per UTC day; 0 = unlimited
// What the brain can do (src/brain/contract.js): the plans and their labels, and whether
// anything transcribes at all.
const INFO = brain.info();
const { plans: PLANS, planEnabled, planLabel } = INFO;
const transcribeEnabled = INFO.enabled;
// Which plan a new account transcribes with.
export const DEFAULT_PLAN = PLANS.includes(process.env.DEFAULT_PLAN) ? process.env.DEFAULT_PLAN : 'pro';
// The same recording forwarded twice (typically into the control group) is not
// paid for twice: its text is remembered in memory only, briefly.
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MINUTES ?? 60) * 60e3;
const DEDUPE_CAP = 200;
const SELF_PREFIX = process.env.SELF_TRX_PREFIX ?? '🎙️ ';
const CAP_MAP = 5000;
// Cheap gate before the brain is asked whether a note dictates a message: a dictation names
// the act of sending. Generous on purpose (stems, not words): its job is to skip the obvious
// non-commands; the brain decides the rest.
const DICTATION_CUE = /(שלח|תגיד|הגיד|כתוב|תעביר|העביר|מסור|הודע|send|tell|text|write|message|let\s+\S+\s+know)/iu;
const looksLikeDictation = (text) => DICTATION_CUE.test(String(text || ''));

const loadJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const saveJson = (file, value) => { try { writeFileSync(file, JSON.stringify(value)); } catch (e) { noteError(e); console.warn('save failed:', file, e.message); } };
// The first line, and for a request that failed on the way, why (net.js).
const firstLine = (e) => netWhy(e);

// View-once media is meant to be seen once and vanish; turning it into text
// would defeat that, so it is never unwrapped, downloaded or transcribed.
// Disappearing (ephemeral) messages are handled, and the reply inherits the
// chat's disappearing timer so the text lives no longer than the recording.
const VIEW_ONCE_KEYS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
function unwrap(message) {
  if (!message) return message;
  if (VIEW_ONCE_KEYS.some((k) => message[k])) return { viewOnce: true };
  const inner = message.ephemeralMessage?.message || message.documentWithCaptionMessage?.message || message;
  if (inner !== message && VIEW_ONCE_KEYS.some((k) => inner?.[k])) return { viewOnce: true };
  return inner;
}
const clampSeconds = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_MEDIA_SECONDS) : 0; };

export class Tenant {
  /** @param {{id:string,label?:string,language?:string,createdAt:number}} rec */
  constructor(rec, dir) {
    Object.assign(this, {
      id: rec.id, label: rec.label || '', language: rec.language || '', createdAt: rec.createdAt,
      sessions: readSessions(rec.sessions), entry: rec.entry?.h ? rec.entry : null, linkedAt: rec.linkedAt || 0, // door.js
      locale: rec.locale === 'he' || rec.locale === 'en' ? rec.locale : '', // the language we talk to the owner in; from their browser at sign-up
      inviteCode: rec.inviteCode || '',        // public: the /i/<code> link this account hands out
      referredBy: rec.referredBy || '',        // the invite code this account arrived through
      invited: Number(rec.invited) || 0,       // friends who linked through it
      bonusMinutes: Number(rec.bonusMinutes) || 0,
      plan: PLANS.includes(rec.plan) ? rec.plan : DEFAULT_PLAN,
      abModel: rec.abModel || '', // set by admin to compare another model on real notes
      // Opt-in, off for everyone unless the owner asked for it: keep a copy of
      // each recording with what the models made of it, to improve the product.
      keepAudio: rec.keepAudio === true,
      transcribeVideo: rec.transcribeVideo === true,
      voiceFix: rec.voiceFix === true,
      // Minutes a day for this account alone, set from the admin page; 0 = the server's default (plus invite bonuses).
      capMinutes: Number.isInteger(rec.capMinutes) && rec.capMinutes > 0 ? rec.capMinutes : 0,
      firstNoteAt: Number(rec.firstNoteAt) || 0, // the owner's first voice note in the group: the end of onboarding
      // How the settings page is used, for the admin page: visits and changes, counts and times only.
      settingsUse: { visits: 0, changes: 0, firstAt: 0, lastAt: 0, lastChangeAt: 0, ...(rec.settingsUse && typeof rec.settingsUse === 'object' ? rec.settingsUse : {}) },
      // What is transcribed and where the text goes, by kind of chat (see settings.js). An account from
      // before the settings page keeps what its "groups" setting meant.
      settings: readSettings(rec),
      paused: rec.paused === true, // the owner wrote "pause": nothing is transcribed until "resume"
      // Who this account is, for the admin page: the linked number and the owner's WhatsApp name.
      phone: /^\d{6,15}$/.test(rec.phone || '') ? rec.phone : '', waName: String(rec.waName || '').slice(0, 80),
    });
    this.dir = dir; mkdirSync(dir, { recursive: true });
    this.tag = `[${this.id.slice(0, 6)}]`;
    this.mediaDir = join(dir, 'media');
    this.f = (name) => join(dir, name);

    // Settings and small state, all JSON files in the account's directory.
    this.target = loadJson(this.f('target.json'), null);           // control group { jid, name }
    this.muted = new Set(loadJson(this.f('muted.json'), []));       // private chats switched off
    this.enabled = new Set(loadJson(this.f('enabled.json'), []));   // groups switched on
    this.quiet = new Set(loadJson(this.f('quiet.json'), []));       // chats in private mode: other people's recordings are transcribed into the control group only
    this.archived = new Set(loadJson(this.f('archived.json'), []));
    this.fwdMap = new Map(loadJson(this.f('fwdmap.json'), []));     // our control-group post id → source chat
    this.mediaSrc = new Map(loadJson(this.f('mediasrc.json'), [])); // media sha256 → source chat
    this.contactNames = new Map(loadJson(this.f('contacts.json'), []));
    this.savedNames = new Set(loadJson(this.f('saved.json'), []));   // contacts whose name came from the phone's address book (partial: only those synced since linking)
    this.groupNames = new Map();
    this.groupSizes = new Map(); // group → how many are in it, for the settings page's list
    this.communities = new Set(); // community parents: no message is ever posted there, so they are never offered as a group
    // chat → { at: its last message, muted: until when (ms; -1 for good) }: times only, so the page lists the live chats first
    this.chatActivity = new Map(loadJson(this.f('chat-activity.json'), []));
    this.altIds = new Map(loadJson(this.f('altids.json'), [])); // phone id ⇄ lid of the same private chat
    this.activity = new Map(loadJson(this.f('activity.json'), [])); // private chat → how many messages the owner sent it (a count, no content): ranks contacts for a dictated message
    this.dictated = new Map();   // our confirmation post id → the message we sent for the owner (memory only, for "undo")
    this.ownPosts = new Set();   // ids of messages we posted (memory only): their echo must never be read as the owner's answer
    this.pendingSend = null;     // a dictated message waiting for the owner to pick the recipient
    this.pendingLeave = null;    // "leave" was written in the control group; waiting for the yes
    this.pendingSwitch = null;   // include/exclude of a chat: waiting for the pick and the yes
    // The owner's last commands and what came of each, for the admin page: the command word, the outcome
    // and whether our reply went out. Never a name or any text. The reply sent next is credited to the newest.
    this.commands = loadJson(this.f('commands.json'), []);
    this.feedback = loadJson(this.f('feedback.json'), []); // what the owner wrote from the settings page, for the operator; erased with the account
    this.cmdNow = null;
    this.seen = new Set(loadJson(this.f('seen.json'), []));         // message ids already handled
    this.glossary = createGlossary(this.f('glossary.json'));
    this.usage = loadJson(this.f('usage.json'), { day: '', seconds: 0, notified: false });
    this.usageHistory = loadJson(this.f('usage-history.json'), []); // [{ day, minutes }], the last 30 days that had any audio
    // Recordings turned into text, ever (counts, seconds and dollars only): the owner's own and everyone else's. Counted from `since`.
    this.totals = loadJson(this.f('totals.json'), null) || { own: 0, others: 0, since: Date.now() };
    this.recent = new Map(); // media sha -> { content, summary, at } — memory only, never on disk
    // The experiment's bookkeeping (memory only, ids and times): which arm a recording went to,
    // and which of our posts carries its text — so a reaction, a deletion, a reply or a new
    // recording right after can be counted against the arm.
    this.abPosts = new Map();   // our message id -> { recId, arm, at, chatId, sender }
    this.ownMarks = new Set();  // ids of the reactions we put on recordings ourselves (not a signal from anyone)
    this.fixable = new Map();   // voiceFix accounts only: our transcript's message id -> { key, chatId, prefix, body, at, fromMe, speaker } (memory, 15 min)
    this.abRecs = new Map();    // recording id -> { arm, at, chatId, sender }
    this.abLastPost = new Map(); // `${chatId}|${sender}` -> { arm, at, recId }

    this.link = null; this.sock = null; this.ownId = null; this.ownLid = null;
    this.lastSentAt = 0; // when this account last sent a message (pacing)
    this.mode = 'starting'; this.qr = null; this.ready = false;
    this.pairPhone = ''; this.pairingCode = null; // link with a code instead of a scan: the number, and the code in force
    this.pairRefreshedAt = 0; // WhatsApp answered a scan by changing the code: the phone has to scan again
    this.lastMessageAt = 0; this.lastError = null; this.needsManualGroup = false;
    this.stats = { transcribed: 0, dropped: 0, failed: 0 };
    this.sendChain = Promise.resolve();
    this.slots = createSemaphore(PER_ACCOUNT_CONCURRENCY);
    this.stopped = false;
    this.abort = new AbortController(); // shared cancel signal for this account's downloads
    this.inFlight = new Set();          // running jobs, awaited by stop()
    const swept = sweepMediaDir(this.mediaDir); // nothing from before a crash/restart may linger
    if (swept) console.log(`${this.tag} 🧹 removed ${swept} leftover media file(s)`);
  }

  // ---------- lifecycle ----------
  async start() {
    this.link = createLink({
      dir: this.dir, tag: this.tag,
      onQr: async (qr) => {
        this.ready = false; this.mode = 'qr'; this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        if (this.pairPhone && !this.pairingCode) await this.issuePairingCode(); // a new socket: the old code died with the last one
      },
      onPairRefresh: () => { this.pairRefreshedAt = Date.now(); },
      onReady: (sock) => this.onReady(sock),
      onClose: () => { this.ready = false; this.qr = null; this.pairingCode = null; this.pairRefreshedAt = 0; if (this.mode === 'connected') this.mode = 'reconnecting'; },
      onLoggedOut: () => { this.mode = 'logged_out'; this.ready = false; },
      // Once linked, a lost pairing is only renewed while the owner has the link page open (see keepPairing).
      wantPairing: () => !this.linkedAt || Date.now() - (this.lastViewedAt || 0) < 3 * 60e3,
      onAsleep: () => { this.mode = 'logged_out'; this.ready = false; this.qr = null; this.pairingCode = null; },
      onMessage: (m, sock) => this.onMessage(m, sock),
      onChats: (chats) => this.onChats(chats),
      onContacts: (contacts) => this.onContacts(contacts),
    });
    await this.link.start();
  }

  async stop({ logout = false } = {}) {
    this.stopped = true; this.mode = 'stopped'; this.ready = false;
    claims.unlink(this.id);
    this.flushSaves();                  // whatever was waiting to be written is written now
    this.abort.abort();                 // downloads in progress are destroyed now
    // In-flight jobs stop at their next checkpoint; wait for them (bounded) so
    // that when we report "erased", nothing is still running.
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, 15000))]);
    const r = await this.link?.stop({ logout });
    if (logout && r && !r.loggedOut) console.warn(`${this.tag} ⚠️ WhatsApp did not confirm the logout — remove the device in WhatsApp → Linked devices to be sure`);
    return r;
  }

  async onReady(sock) {
    this.sock = sock;
    this.ownId = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
    this.ownLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
    claims.link(this.id, [this.ownId, this.ownLid]);
    this.ready = true; this.qr = null; this.mode = 'connected';
    const phone = this.ownId?.split('@')[0] || '', waName = String(sock.user?.name || sock.user?.verifiedName || this.waName).slice(0, 80);
    const known = (phone && phone !== this.phone) || waName !== this.waName; this.phone = phone || this.phone; this.waName = waName;
    if (!this.linkedAt) { this.linkedAt = Date.now(); this.persistRecord(); this.onFirstLink?.(this); profileOnce('first link'); } // what the first minute of a new link costs the processor
    else if (known) this.persistRecord();
    this.pairPhone = ''; this.pairingCode = null;
    console.log(`${this.tag} ✅ connected as ${this.ownId?.replace(/^(\d{5})\d+/, '$1…')}${this.target ? ' · control group set' : ' · no control group yet'}`);
    if (!this.target) await this.createControlGroup();
    else if (!this.target.icon) await this.setGroupIcon(); // groups made before the icon existed
  }

  /** Link with a code: remember the number, and ask for a code now if a socket is waiting for a scan. */
  /** The owner opened the link page: if this account had gone to sleep without a pairing, it asks WhatsApp for a code again. */
  wake() { this.lastViewedAt = Date.now(); return this.link?.wake() || false; }

  async requestPairingCode(phone) {
    const digits = normalizePhone(phone);
    if (!digits) return false;
    this.pairPhone = digits; this.pairingCode = null;
    if (this.mode === 'qr' && this.link?.sock) await this.issuePairingCode();
    return true;
  }
  usePairingQr() { this.pairPhone = ''; this.pairingCode = null; }
  async issuePairingCode() {
    try { this.pairingCode = await this.link.requestPairingCode(this.pairPhone); console.log(`${this.tag} 🔢 pairing code issued`); }
    catch (e) { console.warn(`${this.tag} pairing code failed: ${firstLine(e)}`); }
  }

  /** The control group wears the logo. Best effort, once. */
  async setGroupIcon() {
    if (!this.target || !this.sock) return;
    try {
      await Promise.race([this.sock.updateProfilePicture(this.target.jid, Buffer.from(LOGO_MARK_SVG)), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 30000))]);
      this.target.icon = Date.now(); saveJson(this.f('target.json'), this.target);
      console.log(`${this.tag} 🖼️ control group icon set`);
    } catch (e) { console.warn(`${this.tag} could not set the group icon: ${firstLine(e)}`); }
  }

  /**
   * A link that opens the control group in WhatsApp, for the button on the settings page: the
   * group's invite link, made only once joining needs the owner's approval, so a link that gets
   * out lets nobody in. Null when WhatsApp would not do either.
   */
  groupLink() {
    const url = (code) => `https://chat.whatsapp.com/${code}`;
    if (this.target?.invite) return Promise.resolve(url(this.target.invite));
    if (!this.target?.jid || !this.sock || !this.ready) return Promise.resolve(null);
    this._linkP ??= (async () => {
      const jid = this.target.jid, within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 15000))]);
      try {
        await within(this.sock.groupJoinApprovalMode(jid, 'on'));
        const code = await within(this.sock.groupInviteCode(jid));
        if (!code || this.target?.jid !== jid) return null;
        this.target.invite = code; saveJson(this.f('target.json'), this.target);
        console.log(`${this.tag} 🔗 control group link made (joining needs approval)`);
        return url(code);
      } catch (e) { console.warn(`${this.tag} no control group link: ${firstLine(e)}`); return null; }
      finally { this._linkP = null; }
    })();
    return this._linkP;
  }

  /**
   * A change to how the owner's chat list shows the control group (marked unread). These sync to
   * every device of theirs; right after linking WhatsApp may not take them yet, so they are tried again.
   */
  modifyControlGroup(what, mod, done, delays = [15e3, 120e3]) {
    const jid = this.target?.jid; if (!jid) return;
    const attempt = async (i) => {
      if (this.stopped || this.target?.jid !== jid || done()) return;
      try { await this.sock.chatModify(mod, jid); this.target[what] = Date.now(); saveJson(this.f('target.json'), this.target); console.log(`${this.tag} 📌 control group ${what}`); }
      catch (e) { if (i < delays.length) setTimeout(() => attempt(i + 1), delays[i]).unref?.(); else console.warn(`${this.tag} control group not ${what}: ${firstLine(e)}`); }
    };
    attempt(0);
  }
  /**
   * The welcome is the owner's own message, so WhatsApp would show it read and never notify: the group is
   * marked unread instead (the dot in the chat list), so it stands out until they open it. It is not pinned:
   * the pins are the owner's, and the welcome alone brings the group to the top of the list.
   */
  markControlGroupUnread(welcome, delays) {
    if (!welcome?.key?.id) return;
    const last = { key: welcome.key, messageTimestamp: welcome.messageTimestamp || Math.floor(Date.now() / 1000) };
    this.modifyControlGroup('marked unread', { markRead: false, lastMessages: [last] }, () => this.target?.['marked unread'], delays);
  }

  /**
   * The values a note's text can use, filled in for this account at the moment it is sent:
   * {link} their settings page (signs them in, three hours), {invite} their invite link, {name} the first
   * word of their WhatsApp name, {week_minutes} audio minutes transcribed in the last 7 days,
   * {total_notes} and {total_minutes} since they joined.
   */
  noteValues(now = Date.now()) {
    const week = new Set(Array.from({ length: 7 }, (_, i) => new Date(now - i * 864e5).toISOString().slice(0, 10)));
    const weekMinutes = this.usageHistory.filter((h) => week.has(h.day)).reduce((a, h) => a + (h.minutes || 0), 0) + Math.round(this.usageSecondsToday() / 60);
    const tot = this.totals || {};
    return {
      link: settingsUrl(this.id) || '', invite: SITE_URL && this.inviteCode ? `${SITE_URL}/i/${this.inviteCode}` : '',
      name: String(this.waName || '').trim().split(/\s+/)[0] || '', week_minutes: String(weekMinutes),
      total_notes: String((tot.own || 0) + (tot.others || 0)), total_minutes: String(Math.round(((tot.ownSeconds || 0) + (tot.othersSeconds || 0)) / 60)),
    };
  }
  /**
   * Whether audio was transcribed here on any of the last `days` days, today included. Read from the
   * usage kept on disk: the time of the last message is memory only, and a restart would forget it.
   */
  transcribedWithin(days, now = Date.now()) {
    if (this.usageSecondsToday() > 0) return true;
    const since = new Set(Array.from({ length: days }, (_, i) => new Date(now - i * 864e5).toISOString().slice(0, 10)));
    return this.usageHistory.some((h) => since.has(h.day));
  }

  /**
   * A note from us, posted in the owner's own control group, in their language (the welcome's choice),
   * with the values above filled in, an optional picture (the text is its caption), and the group marked
   * unread like every post there. Each named note goes to an account once (recorded in target.json)
   * unless forced, as for a test. Resolves to what happened.
   */
  async sendNote(noteName, { he: textHe, en: textEn, image = null }, { force = false } = {}) {
    if (!this.ready || !this.target?.jid) return 'not connected';
    if (!force && this.target.announced?.includes(noteName)) return 'already sent';
    const he = this.ownerLocale() === 'he', values = this.noteValues();
    const text = String(he ? textHe : textEn).replace(/\{(\w+)\}/g, (all, k) => (k in values ? values[k] : all));
    await this.sendPaced(this.target.jid, image ? { image, caption: text } : { text });
    if (!force) { this.target.announced = [...(this.target.announced || []), noteName]; saveJson(this.f('target.json'), this.target); }
    console.log(`${this.tag} 📣 note "${noteName}" posted (${he ? 'he' : 'en'}${image ? ', with a picture' : ''}${force ? ', test' : ''})`);
    return he ? 'sent (he)' : 'sent (en)';
  }

  /**
   * The control group's description: where to send a friend, and how to reach the settings. The text is
   * the one last set from the admin page (DATA_DIR/control-description.json, so it changes without a
   * deploy), else the default below, in the owner's language. Nothing is sent when it is already that.
   */
  static controlDescription() {
    const fallback = {
      he: 'לינק לשיתוף: https://ramble.baby\nלהגדרות ואפשרויות כתבו "settings"',
      en: 'Link to share: https://ramble.baby\nFor settings and options, write "settings"',
    };
    const saved = loadJson(dataPath('control-description.json'), null);
    return saved?.he && saved?.en ? saved : fallback;
  }
  async setControlDescription(texts = Tenant.controlDescription()) {
    const jid = this.target?.jid;
    if (!jid || !this.sock?.groupUpdateDescription) return 'not connected';
    const text = String(this.ownerLocale() === 'he' ? texts.he : texts.en);
    if (this.target.description === text) return 'already set';
    await this.sock.groupUpdateDescription(jid, text);
    this.target.description = text; saveJson(this.f('target.json'), this.target);
    console.log(`${this.tag} 📝 control group description set`);
    return 'set';
  }

  /**
   * Everything we post in the control group is the owner's own message, so WhatsApp shows it read and
   * never notifies. Each one marks the group unread (the dot in the chat list) unless it still is: the
   * owner's devices tell us when they read it (onChats). If that news never comes, it is marked again
   * after ten minutes anyway. An archived group stays archived. Best effort: a failure changes nothing.
   */
  markControlUnread(sent, now = Date.now()) {
    const jid = this.target?.jid;
    if (!jid || !sent?.key?.id || this.archived.has(jid) || typeof this.sock?.chatModify !== 'function') return false;
    if (this.controlUnread && now - (this.controlMarkedAt || 0) < 10 * 60e3) return false;
    const last = { key: sent.key, messageTimestamp: sent.messageTimestamp || Math.floor(now / 1000) };
    this.controlUnread = true; this.controlMarkedAt = now;
    try { Promise.resolve(this.sock.chatModify({ markRead: false, lastMessages: [last] }, jid)).catch(() => { this.controlUnread = false; }); } catch { this.controlUnread = false; }
    return true;
  }

  /** First link: create the control group with just the owner in it and post the welcome. */
  async createControlGroup() {
    try {
      const g = await this.sock.groupCreate(PRODUCT_NAME, []);
      if (!g?.id) throw new Error('no group id returned');
      this.target = { jid: g.id, name: PRODUCT_NAME, setAt: Date.now() };
      saveJson(this.f('target.json'), this.target);
      this.needsManualGroup = false;
      console.log(`${this.tag} 🎯 control group created`);
      await this.setGroupIcon();
      await this.setControlDescription(); // where to share us from, and how to reach the settings
      await this.groupLink(); // the settings page's button opens the group through it
      const welcome = await this.sendPaced(g.id, { text: this.welcomeText() });
      this.markControlGroupUnread(welcome);
    } catch (e) {
      this.needsManualGroup = true;
      console.warn(`${this.tag} could not create the control group (${firstLine(e)}) — user must create one and post #transcribe`);
    }
  }

  // In Hebrew texts every line starts with a Hebrew letter: WhatsApp takes a line's direction
  // from its first letter, and one that opens with "Ramble" or "on" comes out left-to-right.
  /** The language we talk to the owner in: their browser's at sign-up, else a Hebrew transcription setting or an Israeli number. */
  ownerLocale() {
    if (this.locale) return this.locale;
    return this.language === 'he' || (!this.language && this.ownId?.startsWith('972')) ? 'he' : 'en';
  }

  /**
   * The first message in the new group. It says what the defaults do, above all that the text appears to the
   * other side too, since people missed that; the settings page has the rest. Its link opens that page (with
   * its welcome); a browser that is not signed in shows a code to send here first (door.js).
   */
  welcomeText() {
    const url = settingsUrl(this.id, { welcome: true });
    if (this.ownerLocale() === 'he') return `🎉 ברוכים הבאים ל-*${PRODUCT_NAME}*!
הוואטסאפ שלכם מחובר. הקבוצה הזו היא לוח הבקרה שלכם, ורק אתם בה.

*מה קורה מעכשיו:*
• *בשיחות אישיות*, כל הודעה קולית, שלכם ושל הצד השני, מקבלת טקסט ממש מתחתיה. הטקסט מופיע לשני הצדדים, כדי ששניכם תיהנו ממנו.
• *בקבוצות*, רק ההודעות הקוליות שלכם מתומללות, והטקסט מופיע בקבוצה לכולם.

${url ? `רוצים שהטקסט יגיע רק אליכם, לכאן? את זה ועוד אפשר לשנות בהגדרות: ${url}

כדי לחזור להגדרות בהמשך, כותבים כאן *settings*.` : 'לרשימת הפקודות, כותבים כאן *help*.'}`;
    return `🎉 Welcome to *${PRODUCT_NAME}*!
Your WhatsApp is linked. This group is your control panel, and only you are in it.

*What happens from now on:*
• *In private chats*, every voice note, yours and the other person's, gets its text right under it. Both of you see the text, so you both get to enjoy it.
• *In groups*, only your own voice notes are transcribed, and the text appears in the group for everyone.

${url ? `Want the text to come only to you, here? You can change that and more in the settings: ${url}

To get back to the settings later, write *settings* here.` : 'For the list of commands, write *help* here.'}`;
  }

  helpText() {
    if (this.ownerLocale() === 'he') return `*הפקודות של ${PRODUCT_NAME}*
כל פקודה היא מילה אחת באנגלית.

• הגדרות, *settings*: לכתוב כאן כדי לקבל קישור לדף ההגדרות, ושם לבחור מה מתומלל, של מי, ואיפה הטקסט מופיע.
• הפעלה וכיבוי של צ'אט, *include* / *exclude*: לכתוב כאן *exclude* ואת שם איש הקשר או הקבוצה, או מספר טלפון (למשל *exclude אמא*), ו-*include* כדי לתמלל בו את כולם. תמיד נשאלת קודם שאלה, ועונים *yes*. צ'אט מוחרג לא מתומלל בכלל, גם לא ההודעות הקוליות שלך.
• קבוצות, *groups*: מה קורה בקבוצות שלא הוגדרו אחרת. *groups off*: כלום. *groups mine*: רק ההודעות הקוליות שלך, עם טקסט בקבוצה. *groups others*: רק של אחרים, עם טקסט בקבוצה. *groups all*: של כולם, עם טקסט בקבוצה. *groups private*: של כולם, עם הטקסט רק כאן.
• תמלול בפרטיות, *private*: לכתוב כאן *private* ואת השם, והטקסט של כל הקלטה שם, גם שלך, יגיע רק לכאן, בלי שום דבר בצ'אט ההוא.
• מחיקת טקסט, *delete*: לענות כך לכל טקסט ש-${PRODUCT_NAME} פרסם, בכל צ'אט, והוא נמחק אצל כולם.
• שפת התמלול, *language*: לכתוב כאן *language* כדי לראות אותה, ו-*language hebrew* (או שפה אחרת, או *auto*) כדי לקבוע. בדרך כלל אין צורך: השפה מזוהה לבד.
• עצירה והמשך, *pause* / *resume*: לכתוב כאן כדי לעצור את כל התמלולים, ולהמשיך מתי שרוצים.
• התנתקות, *leave*: לכתוב כאן כדי לנתק את ${PRODUCT_NAME} ולמחוק את החשבון. נשאלת קודם שאלה, ועונים לה *yes* או *no*.
• הרשימה הזו: *help*.`;
    return `*${PRODUCT_NAME} commands*
Each one is a single word.

• *settings*: write it here for a link to your settings page, to choose what gets transcribed, whose, and where the text appears.
• *include* / *exclude*: write it here with a contact's or a group's name, or a phone number (*exclude Mom*), to switch that chat, or reply it to a forwarded recording's text. *include* transcribes everyone there. It always asks first; answer *yes*. An excluded chat is not transcribed at all, your own voice notes included.
• *groups*: what happens in groups you haven't switched. *groups off*: nothing. *groups mine*: your own voice notes, with the text in the group. *groups others*: only other people's, with the text in the group. *groups all*: everyone's, with the text in the group. *groups private*: everyone's, with the text only here.
• *private*: write it here with a name, and the text of every recording in that chat, yours included, comes only here; nothing is posted there.
• *delete*: reply with it to any text ${PRODUCT_NAME} posted, in any chat, and it's removed for everyone.
• *language*: write it here to see the transcription language, and *language hebrew* (or another, or *auto*) to fix it. Rarely needed: it's detected on its own.
• *pause* / *resume*: write it here to stop all transcription for a while, and to start again.
• *leave*: write it here to unlink ${PRODUCT_NAME} and erase your account. It asks first; answer *yes* or *no*.
• *help*: this list.`;
  }

  pauseReply(how) {
    const he = this.ownerLocale() === 'he';
    const t = {
      paused: ['⏸️ Paused. Nothing is transcribed until you write *resume* here.', '⏸️ מושהה. שום הקלטה לא מתומללת עד שכותבים כאן *resume*.'],
      resumed: ['▶️ Back on. Voice notes get their text again.', '▶️ חוזרים לפעול. הודעות קוליות מקבלות שוב טקסט.'],
      'already-paused': ['⏸️ Already paused. Write *resume* to start again.', '⏸️ כבר מושהה. כדי להמשיך, לכתוב כאן *resume*.'],
      'already-running': ["▶️ It's running. Write *pause* to stop it for a while.", '▶️ הכול פועל. כדי לעצור לזמן מה, לכתוב כאן *pause*.'],
      'paused-note': ['⏸️ Paused, so this was not transcribed. Write *resume* to start again.', '⏸️ מושהה, ולכן ההקלטה הזו לא תומללה. כדי להמשיך, לכתוב כאן *resume*.'],
    }[how];
    return t[he ? 1 : 0];
  }

  /** Answer "groups" (show the setting) or "groups off" / "groups mine" (after setting it). */
  groupsReply(how) {
    const he = this.ownerLocale() === 'he', g = this.groups;
    const say = {
      mine: he ? "👥 בכל קבוצה (חוץ מאלה שהוחרגו) ההודעות הקוליות שלך מקבלות טקסט מתחתיהן. של אחרים מתומללות רק בקבוצות שהופעלו עם *include*."
        : "👥 In every group (except excluded ones), your own voice notes get their text under them. Other people's are transcribed only in groups you *include*.",
      'mine-private': he ? '👥 בכל קבוצה (חוץ מאלה שהוחרגו) ההודעות הקוליות שלך מתומללות אל הקבוצה הזו בלבד. שום דבר לא נכתב בקבוצות עצמן.'
        : '👥 In every group (except excluded ones), your own voice notes are transcribed into this group only. Nothing is posted in the groups.',
      others: he ? '👥 בכל קבוצה (חוץ מאלה שהוחרגו) ההודעות הקוליות של אחרים מקבלות טקסט מתחתיהן. שלך לא מתומללות.'
        : "👥 In every group (except excluded ones), other people's voice notes get their text under them. Yours aren't transcribed.",
      'others-private': he ? '👥 בכל קבוצה (חוץ מאלה שהוחרגו) ההודעות הקוליות של אחרים מתומללות אל הקבוצה הזו בלבד. שלך לא מתומללות, ושום דבר לא נכתב בקבוצות עצמן.'
        : "👥 In every group (except excluded ones), other people's voice notes are transcribed into this group only. Yours aren't, and nothing is posted in the groups.",
      all: he ? '👥 בכל קבוצה (חוץ מאלה שהוחרגו) כל הודעה קולית, שלך ושל כולם, מקבלת טקסט מתחתיה.'
        : "👥 In every group (except excluded ones), every voice note, yours and everyone's, gets its text under it.",
      private: he ? "👥 בכל קבוצה שלא הוגדרה אחרת, כל הודעה קולית, שלך ושל כולם, מתומללת אל הקבוצה הזו בלבד. שום דבר לא נכתב בקבוצות עצמן."
        : "👥 In every group you haven't switched, every voice note, yours and everyone's, is transcribed into this group only. Nothing is posted in the groups.",
      off: he ? "👥 שום דבר לא מתומלל בקבוצות, לא שלך ולא של אחרים, אלא אם קבוצה הופעלה עם *include* (טקסט בקבוצה) או *private* (טקסט כאן)."
        : "👥 Nothing is transcribed in groups, yours or anyone's, unless you *include* one (text in the group) or make it *private* (text here).",
    };
    // Groups picked on the settings page: only those, whichever of these is set.
    const picked = g !== 'off' && this.settings.groups.some.length ? `\n${he ? 'רק בקבוצות שבחרת בדף ההגדרות (*settings*).' : 'Only in the groups you picked on the settings page (*settings*).'}` : '';
    if (how === 'set') return `${he ? '👥 בוצע: ' : '👥 Done: '}${say[g].replace(/^👥 /, '')}${picked}`;
    const options = {
      off: he ? 'שום דבר בקבוצות: *groups off*' : '*groups off*: nothing in groups',
      mine: he ? 'רק ההודעות הקוליות שלך, עם טקסט בקבוצה: *groups mine*' : '*groups mine*: just your own voice notes, with the text in the group',
      others: he ? 'רק ההודעות הקוליות של אחרים, עם טקסט בקבוצה: *groups others*' : "*groups others*: only other people's voice notes, with the text in the group",
      all: he ? 'ההודעות הקוליות של כולם, עם טקסט בקבוצה: *groups all*' : "*groups all*: everyone's voice notes, with the text in the group",
      private: he ? 'כל ההודעות הקוליות, עם הטקסט רק כאן: *groups private*' : "*groups private*: everyone's voice notes, with the text only here",
    };
    const others = Object.keys(options).filter((k) => k !== g).map((k) => `• ${options[k]}`).join('\n');
    return `${say[g]}${picked}\n${he ? 'אפשר גם:' : 'Or:'}\n${others}`;
  }

  /** Answer "language" (show it) or "language <name>" (set it). */
  languageReply(word) {
    const he = this.ownerLocale() === 'he';
    const label = (row) => (he ? row[3] : row[2]);
    const names = LANGUAGES.map((r) => r[1]).join(', ');
    if (!word) {
      const cur = LANGUAGES.find((r) => r[0] === (this.language || '')) || LANGUAGES[0];
      return he
        ? `🌐 שפת התמלול: *${label(cur)}*.\nכדי לקבוע שפה, לכתוב כאן *language* ואחריה אחת מאלה: ${names}.`
        : `🌐 Transcription language: *${label(cur)}*.\nTo fix it, write *language* and one of: ${names}.`;
    }
    const row = findLanguage(word);
    if (!row) return he ? `🤷 לא מכיר את השפה הזו. אפשר לבחור מאלה: ${names}.` : `🤷 I don't know that one. Pick from: ${names}.`;
    this.setLanguage(row[0]);
    if (!row[0]) return he ? '🌐 חזרנו לזיהוי אוטומטי: השפה של כל הקלטה מזוהה לבד.' : "🌐 Back to auto-detect: each recording's language is worked out on its own.";
    return he
      ? `🌐 שפת התמלול נקבעה: *${label(row)}*. כל הקלטה תתומלל בשפה הזו. *language auto* מחזיר לזיהוי אוטומטי.`
      : `🌐 Transcription language set to *${label(row)}*. Every recording is transcribed as ${label(row)} now. *language auto* goes back to detecting it.`;
  }

  // ---------- state persistence ----------
  persistRecord() { saveJson(this.f('tenant.json'), { settings: this.settings, id: this.id, label: this.label, language: this.language, createdAt: this.createdAt, sessions: this.sessions, entry: this.entry || undefined, linkedAt: this.linkedAt, locale: this.locale, plan: this.plan, abModel: this.abModel, keepAudio: this.keepAudio, transcribeVideo: this.transcribeVideo || undefined, voiceFix: this.voiceFix || undefined, inviteCode: this.inviteCode, referredBy: this.referredBy, invited: this.invited, bonusMinutes: this.bonusMinutes, paused: this.paused, groups: legacyGroups(this.settings), capMinutes: this.capMinutes || undefined, firstNoteAt: this.firstNoteAt, settingsUse: this.settingsUse, phone: this.phone, waName: this.waName }); }

  /** Today's ceiling for this account: the server default plus whatever invites earned. */
  dailyCapMinutes() { return this.capMinutes > 0 ? this.capMinutes : DAILY_MINUTES_CAP > 0 ? DAILY_MINUTES_CAP + this.bonusMinutes : 0; }
  /** The admin's limit for this account; 0 goes back to the server's default. */
  setCapMinutes(n) { this.capMinutes = Number.isInteger(n) && n > 0 ? Math.min(n, 1440) : 0; if (this.usage.notified && !this.overCap()) { this.usage.notified = false; saveJson(this.f('usage.json'), this.usage); } this.persistRecord(); console.log(`${this.tag} ⏱️ daily limit → ${this.capMinutes || 'default'}`); return this.capMinutes; }

  /** A friend who used this account's invite link just linked their WhatsApp. */
  creditInvite() {
    this.invited += 1;
    if (INVITE_BONUS_MINUTES > 0 && this.bonusMinutes < INVITE_BONUS_MAX) {
      this.bonusMinutes = Math.min(INVITE_BONUS_MAX, this.bonusMinutes + INVITE_BONUS_MINUTES);
    }
    this.persistRecord();
    console.log(`${this.tag} 🎁 invite accepted (${this.invited} so far, +${this.bonusMinutes} min/day)`);
    if (this.target?.jid) {
      this.sendPaced(this.target.jid, { text: `🎉 Someone you invited just joined ${PRODUCT_NAME}. Your daily limit is now *${this.dailyCapMinutes()} minutes*.` }).catch(() => {});
    }
  }
  /** Admin only, a pilot: a spoken reply to one of our transcripts, from its speaker, corrects it in place. */
  setVoiceFix(on) { this.voiceFix = !!on; if (!this.voiceFix) this.fixable.clear(); this.persistRecord(); console.log(`${this.tag} ✏️ corrections by voice → ${this.voiceFix ? 'ON' : 'OFF'}`); return this.voiceFix; }
  /** Admin only, not in the user's settings: this account's videos are transcribed too. */
  setTranscribeVideo(on) { this.transcribeVideo = !!on; this.persistRecord(); console.log(`${this.tag} 🎬 videos transcribed → ${this.transcribeVideo ? 'ON' : 'OFF'}`); return this.transcribeVideo; }
  setKeepAudio(on) { this.keepAudio = !!on; this.persistRecord(); console.log(`${this.tag} 🎧 keep recordings for product work → ${this.keepAudio ? 'ON' : 'OFF'}`); return this.keepAudio; }
  setPlan(plan) { if (!PLANS.includes(plan)) return false; this.plan = plan; this.persistRecord(); console.log(`${this.tag} 💳 plan → ${plan} (${planLabel(plan)})`); return true; }
  setAbModel(model) { this.abModel = String(model || '').slice(0, 60); this.persistRecord(); console.log(`${this.tag} 🧪 A/B model → ${this.abModel || 'off'}`); return true; }

  // ---------- dedupe (memory only) ----------
  cachedFor(sha) {
    if (!sha) return null;
    const hit = this.recent.get(sha);
    if (!hit) return null;
    if (Date.now() - hit.at > DEDUPE_TTL_MS) { this.recent.delete(sha); return null; }
    return hit;
  }
  cacheText(sha, content, summary) {
    if (!sha) return;
    this.recent.set(sha, { content, summary, at: Date.now() });
    while (this.recent.size > DEDUPE_CAP) this.recent.delete(this.recent.keys().next().value);
  }
  setLanguage(code) { this.language = code; this.persistRecord(); console.log(`${this.tag} 🌐 language set to ${code || 'auto'}`); }
  saveSet(name, set) { saveJson(this.f(name), [...set]); }
  /**
   * Save a file soon rather than now. Names, archive flags and the like arrive in hundreds of
   * small events while an account syncs, and each save is the whole file, synchronously, on a
   * network volume; one write a second or two later is the same file on disk with none of the
   * standing still. Pending saves are written when the account stops.
   */
  saveSoon(name, write, delayMs = 1500) {
    this._soon ??= new Map();
    if (this._soon.has(name)) return;
    const t = setTimeout(() => { this._soon.delete(name); if (!this.stopped) write(); }, delayMs); t.unref?.();
    this._soon.set(name, { t, write });
  }
  flushSaves() { for (const [name, { t, write }] of this._soon || []) { clearTimeout(t); this._soon.delete(name); try { write(); } catch { /* best effort */ } } }
  saveMap(name, map, cap = CAP_MAP) { while (map.size > cap) map.delete(map.keys().next().value); saveJson(this.f(name), [...map]); }
  recordFwd(sentId, src) { if (sentId && src?.chatId) { this.fwdMap.set(sentId, { chatId: src.chatId, name: src.name }); this.saveMap('fwdmap.json', this.fwdMap); } }
  recordMediaSource(sha, src) { if (sha && src?.chatId) { this.mediaSrc.set(sha, { chatId: src.chatId, name: src.name, ts: Date.now() }); this.saveMap('mediasrc.json', this.mediaSrc, 3000); } }
  markSeen(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > CAP_MAP) this.seen.delete(this.seen.values().next().value);
    if (!this._seenTimer) this._seenTimer = setTimeout(() => { this._seenTimer = null; this.saveSet('seen.json', this.seen); }, 5000);
    return true;
  }
  isSelfChat(jid) { return (this.ownId && jid === this.ownId) || (this.ownLid && jid === this.ownLid); }

  onChats(chats) {
    if (!Array.isArray(chats)) return;
    let changed = false, named = false, paired = false;
    for (const c of chats) {
      const id = c?.id; if (!id) continue;
      // The owner read (0) or marked unread (-1) the control group on one of their devices.
      if (id === this.target?.jid && (c.unreadCount === 0 || c.unreadCount === -1)) this.controlUnread = c.unreadCount === -1;
      const arch = c.archived ?? c.archive;
      if (arch === true && !this.archived.has(id)) { this.archived.add(id); changed = true; }
      else if (arch === false && this.archived.has(id)) { this.archived.delete(id); changed = true; }
      // The name the chat list shows — for a business or anyone not saved, often the only one there is.
      const name = String(c.name || c.displayName || '').trim().slice(0, 80);
      if (name && id.endsWith('@g.us')) { if (!this.groupNames.get(id)) this.groupNames.set(id, name); }
      else if (name && !this.isSelfChat(id)) named = this.learnName(id, name) || named;
      if (c.pnJid && c.lidJid) paired = this.learnAltIds(jidNormalizedUser(c.pnJid), jidNormalizedUser(c.lidJid), { save: false }) || paired;
    }
    let active = false;
    for (const c of chats) if (c?.id) active = this.noteChat(c.id, { at: Number(c.conversationTimestamp || c.lastMessageRecvTimestamp || 0) * 1000, muted: 'muteEndTime' in c ? c.muteEndTime : undefined }) || active;
    if (active) this.saveActivitySoon();
    if (changed) this.saveSoon('archived.json', () => this.saveSet('archived.json', this.archived));
    if (named) this.saveSoon('contacts.json', () => this.saveMap('contacts.json', this.contactNames, 5000));
    // One write for the whole list, not one per pair: a first bundle brings hundreds of pairs, and each
    // write is the whole file, synchronously, on a network volume — the server stood still for the lot.
    if (paired) this.saveMap('altids.json', this.altIds, 6000);
  }
  /** When a chat last had a message, and whether it is muted (mute end in seconds or ms; negative is for good; empty is not muted). */
  noteChat(jid, { at = 0, muted } = {}) {
    if (!/@(g\.us|s\.whatsapp\.net|lid)$/.test(jid || '')) return false; // not status, channels or broadcasts
    const cur = this.chatActivity.get(jid) || { at: 0, muted: 0 };
    const next = { at: Math.max(cur.at, Number.isFinite(at) ? at : 0), muted: cur.muted };
    if (muted !== undefined) { const v = Number(muted) || 0; next.muted = v < 0 ? -1 : v > 0 && v < 1e12 ? v * 1000 : v; }
    if (next.at === cur.at && next.muted === cur.muted) return false;
    this.chatActivity.delete(jid); this.chatActivity.set(jid, next); // newest last, so the cap drops the stalest
    return true;
  }
  saveActivitySoon(delayMs) { this.saveSoon('chat-activity.json', () => this.saveMap('chat-activity.json', this.chatActivity, 6000), delayMs); }
  /** A chat's last message and mute state, under either of a person's ids. */
  activityOf(jid) {
    const alt = this.altIds.get(jid), a = this.chatActivity.get(jid) || {}, b = (alt && this.chatActivity.get(alt)) || {};
    return { at: Math.max(a.at || 0, b.at || 0), muted: [a.muted, b.muted].some((m) => m === -1 || m > Date.now()) };
  }
  isMuted(jid) { return this.activityOf(jid).muted; }
  /** A display name for a chat the owner has not saved: never over a saved name. Returns true if it changed. */
  learnName(jid, name) {
    if (!jid || !name || this.savedNames.has(jid) || this.contactNames.get(jid) === name) return false;
    this.contactNames.set(jid, name); return true;
  }
  /** The phone id and the lid of one private chat, when WhatsApp hands them over together. Returns true if it was new. */
  learnAltIds(pn, lid, { save = true } = {}) {
    if (!pn || !lid || this.altIds.get(pn) === lid) return false;
    this.altIds.set(pn, lid); this.altIds.set(lid, pn);
    if (save) this.saveMap('altids.json', this.altIds, 6000);
    return true;
  }
  onContacts(contacts) {
    if (!Array.isArray(contacts)) return;
    let changed = false, savedChanged = false;
    for (const c of contacts) {
      const jid = c?.id; if (!jid || jid.endsWith('@g.us')) continue;
      const saved = c.name || c.verifiedName; const display = c.notify;
      if (saved) { this.contactNames.set(jid, saved); if (!this.savedNames.has(jid)) { this.savedNames.add(jid); savedChanged = true; } changed = true; }
      else if (display && !this.savedNames.has(jid) && !this.contactNames.has(jid)) { this.contactNames.set(jid, display); changed = true; }
    }
    if (changed) this.saveSoon('contacts.json', () => this.saveMap('contacts.json', this.contactNames, 5000));
    if (savedChanged) this.saveSoon('saved.json', () => this.saveSet('saved.json', this.savedNames));
  }
  noteActivity(jid) {
    const count = (this.activity.get(jid) || 0) + 1;
    this.activity.delete(jid); this.activity.set(jid, count); // re-inserted last, so the cap drops the stalest chat
    if (!this._actTimer) { this._actTimer = setTimeout(() => { this._actTimer = null; this.saveMap('activity.json', this.activity, 2000); }, 5000); this._actTimer.unref?.(); }
  }
  /**
   * Names for correcting one recording, so they are spelled right: the ones the owner taught (names: …), the
   * owner's and the speaker's own, and the people in that chat: a group's members (whoever recorded; they
   * see each other there), the other side of a private chat on the owner's own recording. Never the address
   * book at large: the text is posted where the speaker reads it, and a note can try to talk the model into
   * repeating the list it was given.
   */
  async namesFor(n) {
    const extra = [this.waName];
    if (!n.fromMe) extra.push(n.senderName, ...(n.senderIds || []).map((j) => this.contactNames.get(j)));
    if (n.isGroup) extra.push(...await this.memberNames(n.chatId));
    else if (n.fromMe && !n.forwarded) extra.push(...[n.chatId, this.altIds.get(n.chatId)].map((j) => this.contactNames.get(j)));
    return this.glossary.hint(extra.filter(Boolean));
  }
  /** The owner's names for a group's members: asked of WhatsApp once a week per group (members change slowly), never waited on long. */
  async memberNames(jid) {
    const hit = this.memberCache?.get(jid);
    if (hit && Date.now() - hit.at < 7 * 864e5) return hit.names;
    let ids = [];
    // Three seconds at most, on a timer that holds the loop open: an unref'd one let the process
    // end before it fired when nothing else was pending, and the names were never answered.
    let timer;
    try {
      const meta = await Promise.race([this.sock.groupMetadata(jid), new Promise((r) => { timer = setTimeout(r, 3000); })]);
      ids = (meta?.participants || []).flatMap((p) => [p.id, p.phoneNumber, p.lid]).filter(Boolean).map((j) => jidNormalizedUser(j));
    } catch { /* unavailable: no member names this time */ } finally { clearTimeout(timer); }
    const names = [...new Set(ids.map((id) => this.contactNames.get(id) || this.contactNames.get(this.altIds.get(id))).filter(Boolean))].slice(0, 40);
    (this.memberCache ||= new Map()).set(jid, { at: Date.now(), names });
    return names;
  }
  async resolveGroupName(jid) {
    if (this.groupNames.has(jid)) return this.groupNames.get(jid);
    this.groupNames.set(jid, null);
    try { const meta = await this.sock.groupMetadata(jid); this.groupNames.set(jid, meta?.subject || null); } catch { /* not a member */ }
    return this.groupNames.get(jid);
  }

  // ---------- usage cap ----------
  todayKey() { return new Date().toISOString().slice(0, 10); }
  usageSecondsToday() {
    if (this.usage.day !== this.todayKey()) {
      // The day rolled over: yesterday's total goes into the history (minutes only, for the admin view).
      if (this.usage.day && this.usage.seconds > 0) {
        this.usageHistory = [...this.usageHistory.filter((h) => h.day !== this.usage.day), { day: this.usage.day, minutes: Math.round(this.usage.seconds / 60) }].slice(-30);
        saveJson(this.f('usage-history.json'), this.usageHistory);
      }
      this.usage = { day: this.todayKey(), seconds: 0, notified: false };
    }
    return this.usage.seconds;
  }
  addUsage(seconds) { this.usageSecondsToday(); this.usage.seconds = Math.max(0, this.usage.seconds + seconds); saveJson(this.f('usage.json'), this.usage); }
  /** Atomically reserve `seconds` against today's cap: false if it would not fit. */
  reserveUsage(seconds) {
    const used = this.usageSecondsToday();
    const cap = this.dailyCapMinutes();
    if (cap > 0 && used + seconds > cap * 60) return false;
    this.addUsage(seconds); return true;
  }
  overCap() { const cap = this.dailyCapMinutes(); return cap > 0 && this.usageSecondsToday() >= cap * 60; }

  // ---------- messages ----------
  normalize(m) {
    const content = unwrap(m.message);
    if (!content || content.viewOnce) return null;
    let type, body = '', hasMedia = false, isVoice = false, mimetype = null, mediaSha = null, mediaNode = null;
    const shaOf = (node) => (node?.fileSha256 ? Buffer.from(node.fileSha256).toString('base64') : null);
    const seconds = clampSeconds(content.audioMessage?.seconds ?? content.videoMessage?.seconds ?? 0);
    if (content.conversation) { type = 'chat'; body = content.conversation; }
    else if (content.extendedTextMessage) { type = 'chat'; body = content.extendedTextMessage.text || ''; }
    // A message with more than one media object is ambiguous (which one would be
    // validated, which one downloaded?) — refuse it outright.
    else if ([content.videoMessage, content.audioMessage, content.imageMessage, content.documentMessage, content.stickerMessage].filter(Boolean).length > 1) return null;
    else if (content.videoMessage) { type = 'video'; hasMedia = true; mediaNode = content.videoMessage; mimetype = mediaNode.mimetype; mediaSha = shaOf(mediaNode); }
    else if (content.audioMessage) { type = content.audioMessage.ptt ? 'ptt' : 'audio'; hasMedia = true; isVoice = true; mediaNode = content.audioMessage; mimetype = mediaNode.mimetype; mediaSha = shaOf(mediaNode); }
    else return null; // images, documents, stickers, reactions, system messages: not our business
    // Disappearing chat? Our reply must disappear on the same timer.
    const ctx = (mediaNode || content.extendedTextMessage)?.contextInfo;
    const expiration = Number(ctx?.expiration || 0) || 0;
    const forwarded = !!(ctx?.isForwarded || Number(ctx?.forwardingScore) > 0);
    const chatId = m.key.remoteJid;
    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) return null;
    const isGroup = chatId.endsWith('@g.us');
    const fromMe = !!m.key.fromMe;
    const senderName = fromMe ? OWNER_LABEL : (m.pushName || null);
    const ext = content.extendedTextMessage;
    const quoted = ext?.contextInfo?.stanzaId ? ext.contextInfo : null;
    // A voice note recorded as a reply carries what it answers on the audio itself.
    const replyTo = content.audioMessage?.contextInfo?.stanzaId || null;
    // The same private chat may arrive under a phone id or a lid; WhatsApp sends the other one along.
    const chatAlt = m.key.remoteJidAlt ? jidNormalizedUser(m.key.remoteJidAlt) : null;
    // Who sent it, under both ids WhatsApp gives: the chat itself in private, the participant in a group.
    const norm = (j) => (j ? jidNormalizedUser(j) : null);
    const senderIds = isGroup ? [norm(m.key.participant), norm(m.key.participantAlt)].filter(Boolean) : [chatId, chatAlt].filter(Boolean);
    return { id: m.key.id, chatId, chatAlt, senderIds, isGroup, fromMe, senderName, type, body, hasMedia, isVoice, mimetype, mediaSha, mediaNode, seconds, expiration, forwarded, quoted, replyTo };
  }

  async onMessage(m, sock) {
    this.sock = sock;
    // Any message in a chat, of any kind, is activity there: the time only, for the settings page's order.
    if (this.noteChat(m?.key?.remoteJid, { at: Number(m?.messageTimestamp) * 1000 || Date.now() })) this.saveActivitySoon(10e3);
    const n = this.normalize(m);
    try { this.noteSignal(m, n); } catch (e) { console.warn(`${this.tag} signal note failed: ${firstLine(e)}`); }
    if (!n) return;
    this.lastMessageAt = Date.now();

    let chatName;
    if (n.isGroup) chatName = await this.resolveGroupName(n.chatId);
    else if (this.isSelfChat(n.chatId)) chatName = 'Notes to self';
    else {
      // The owner's saved name wins over the name people give themselves, under either of their ids.
      const savedAlt = n.chatAlt && this.savedNames.has(n.chatAlt) ? this.contactNames.get(n.chatAlt) : null;
      if (savedAlt && this.contactNames.get(n.chatId) !== savedAlt) this.contactNames.set(n.chatId, savedAlt);
      else if (!savedAlt && !n.fromMe && n.senderName && !this.savedNames.has(n.chatId)) this.contactNames.set(n.chatId, n.senderName);
      if (!n.fromMe && m.verifiedBizName && this.learnName(n.chatId, String(m.verifiedBizName).trim().slice(0, 80))) this.saveMap('contacts.json', this.contactNames, 5000);
      if (n.chatAlt) this.learnAltIds(...(n.chatId.endsWith('@lid') ? [n.chatAlt, n.chatId] : [n.chatId, n.chatAlt]));
      chatName = this.contactNames.get(n.chatId) || n.chatId.split('@')[0];
    }

    // Who the owner actually writes to is the best hint for which "Eden" they mean.
    if (n.fromMe && !n.isGroup && !this.isSelfChat(n.chatId)) this.noteActivity(n.chatId);

    if (await this.handleCommand(m, n, chatName)) return;
    if (!n.hasMedia) {
      // Text is never stored or processed, except a short reply to our transcript from whoever spoke it,
      // which may correct it (fixTarget): only then does it go to the model, as a spoken one would.
      const fixOf = this.fixTarget(n);
      if (fixOf && this.markSeen(n.id)) await this.amendPost(fixOf, n.body, n, m);
      return;
    }
    if (!this.markSeen(n.id)) return;              // duplicate delivery

    const isVideo = n.type === 'video';
    const isMediaWeCare = n.isVoice || (isVideo && (this.transcribeVideo || TRANSCRIBE_VIDEO || feature('videosAll')));
    if (!isMediaWeCare) return;
    // Where a recording's time goes, step by step (times only, never content): see logTiming.
    n.t = { arrived: Date.now(), sentAt: Number(m.messageTimestamp) * 1000 || 0 };
    const inControl = this.target?.jid && n.chatId === this.target.jid;

    // Fingerprint every recording so a later forward into the control group can be traced back.
    if (!inControl && n.mediaSha) this.recordMediaSource(n.mediaSha, { chatId: n.chatId, name: chatName });

    n.route = this.route(n); // 'chat', 'me', or null: not transcribed
    if (!n.route) return;
    if (!inControl && this.tooLate(n)) return;
    // Paused by the owner: nothing is transcribed, nowhere. A recording in the group gets a reminder.
    if (this.paused) {
      if (inControl && n.fromMe) this.sendPaced(n.chatId, { text: this.pauseReply('paused-note') }, { quoted: m }).catch(() => {});
      return;
    }

    // One recording, one text: the control group is ours alone, everywhere else another
    // account on this server may be looking at the very same message.
    if (inControl) { await this.handleRecording(m, n, chatName, isVideo, inControl); return; }
    // A spoken reply to our transcript, from whoever spoke it: perhaps a correction (see amendPost).
    // Ours to handle, since only this account can edit its post: taken outright, settled as posted.
    const fixOf = this.fixTarget(n);
    if (fixOf) {
      n.fixOf = fixOf;
      const key = `${n.id}|${n.mediaSha || ''}`;
      claims.take(key, this.id, { force: true });
      let done = false;
      try { done = await this.handleRecording(m, n, chatName, isVideo, false); } finally { claims.settle(key, this.id, !!done); }
      return;
    }
    // Only to me: every recording in the chat, the owner's own included, has its text come to the control
    // group only. That is not a post in the chat, so it takes no part in deciding who posts there.
    if (n.route === 'me') {
      // A copy in the control group would outlive a disappearing recording: none is made.
      if (n.expiration) { console.log(`${this.tag} ⏭️ private transcript skipped (disappearing chat)`); return; }
      await this.handleRecording(m, n, chatName, isVideo, inControl);
      return;
    }
    const key = `${n.id}|${n.mediaSha || ''}`;
    if (!await this.claimRecording(key, n)) return;
    if (n.t) n.t.claimed = Date.now();
    let posted = false;
    try { posted = await this.handleRecording(m, n, chatName, isVideo, inControl); }
    finally { claims.settle(key, this.id, !!posted); }
  }

  /** Forget the encryption sessions with the owner's own devices; the next post opens fresh ones (wa.js). */
  resetOwnSessions() { if (!this.link) throw new Error('not connected'); return this.link.resetOwnSessions(); }

  /** A recording older than MAX_RECORDING_AGE_MS now: logged, and true. Its text would come out of context. */
  tooLate(n) {
    const age = n.t?.sentAt ? Date.now() - n.t.sentAt : 0;
    if (!(MAX_RECORDING_AGE_MS > 0) || age <= MAX_RECORDING_AGE_MS) return false;
    console.log(`${this.tag} ⏭️ a recording from ${Math.round(age / 1000)}s ago — too late for its text to make sense, left alone`);
    return true;
  }

  /** True when this recording is ours to transcribe; false when another account's text is already under it. */
  async claimRecording(key, n) {
    if (n.fromMe) return claims.take(key, this.id) || (await claims.outcome(key, CLAIM_WAIT_MS)) !== 'posted' && claims.take(key, this.id, { force: true });
    // Someone else's recording: if its sender has an account here, that account goes first.
    // Only then is there anyone to wait for; otherwise this account starts right away.
    if (!claims.holder(key) && claims.isLinked(n.senderIds || [], this.id)) await new Promise((r) => setTimeout(r, YIELD_MS));
    for (let i = 0; i < 3 && !this.stopped; i++) {
      if (claims.take(key, this.id)) return true;
      const how = await claims.outcome(key, CLAIM_WAIT_MS);
      if (how === 'posted') { console.log(`${this.tag} 🤝 another account posted this recording's text — nothing to add`); return false; }
      if (how === 'timeout') return claims.take(key, this.id, { force: true });
    }
    return false;
  }

  /** Transcribe one recording and post its text. Resolves true once a text is under it. */
  async handleRecording(m, n, chatName, isVideo, inControl) {
    if (this.stopped) return;
    if (n.seconds > 0 && n.seconds < TRANSCRIBE_MIN_SECONDS) { console.log(`${this.tag} ⏭️ skipped a ${n.seconds}s recording`); return; }
    if (MAX_TRANSCRIBE_SECONDS > 0 && n.seconds > MAX_TRANSCRIBE_SECONDS) {
      console.log(`${this.tag} ⏭️ skipped a ${n.seconds}s recording (over the ${MAX_TRANSCRIBE_SECONDS}s limit)`);
      this.noteUsage(n, isVideo, 'skipped', { reason: 'over the length limit' });
      if (this.target) this.sendPaced(this.target.jid, { text: `⏭️ A ${Math.round(n.seconds / 60)}-minute recording was skipped. The limit per recording is ${Math.round(MAX_TRANSCRIBE_SECONDS / 60)} minutes.` }).catch(() => {});
      return;
    }
    if (!transcribeEnabled) return;

    // The same recording again — almost always one forwarded into the control
    // group. Reuse the text: no provider call, no quota, nothing to pay.
    const cached = this.cachedFor(n.mediaSha);
    if (cached) {
      const body = cached.summary ? `*${cached.summary}*\n${cached.content}` : cached.content;
      console.log(`${this.tag} ♻️ same recording again — reused its text`);
      if (inControl) { this.deliverProbe(n, body, isVideo, m); return; }
      return this.deliver(n, chatName, body, isVideo, m);
    }

    // Reserve the quota BEFORE any work, atomically and twice: against this
    // account's daily cap and against the whole server's daily budget.
    const sec = n.seconds || 30;
    if (!budget.reserve(sec)) {
      console.warn(`${this.tag} ⏸️ server daily audio budget reached — skipped`);
      this.noteUsage(n, isVideo, 'cap', { reason: 'server budget' });
      this.notifyOncePerDay('globalCap', `⏸️ ${PRODUCT_NAME} reached its daily limit for today. Transcription resumes tomorrow.`);
      return;
    }
    if (!this.reserveUsage(sec)) {
      budget.refund(sec); // the work never happened; give the server's budget back
      if (!this.usage.notified && this.target) {
        this.usage.notified = true; saveJson(this.f('usage.json'), this.usage);
        this.sendPaced(this.target.jid, { text: `⏸️ That's a lot of talking. You hit today's limit (${this.dailyCapMinutes()} minutes of audio) — back tomorrow.${INVITE_BONUS_MINUTES > 0 && this.bonusMinutes < INVITE_BONUS_MAX ? `\nWant more? Every friend who joins through your invite link adds ${INVITE_BONUS_MINUTES} minutes a day.` : ''}` }).catch(() => {});
      }
      console.log(`${this.tag} ⏸️ over daily cap, skipped`);
      this.noteUsage(n, isVideo, 'cap', { reason: 'daily cap' });
      return;
    }
    if (this.slots.waiting >= MAX_QUEUE) { console.log(`${this.tag} ⏸️ queue full, skipped`); this.noteUsage(n, isVideo, 'skipped', { reason: 'queue full' }); return; }

    // One slot per account and one process-wide; the slot is held until the work
    // has actually finished or been cancelled. Every job is tracked so stop() can
    // cancel it and wait for it.
    const job = this.slots.run(() => globalSlots.run(async () => {
      if (this.stopped) return;
      const mark = (k) => { if (n.t) n.t[k] = Date.now(); };
      mark('slot');
      // Its turn came late (a backlog): the same rule as on arrival, and the quota goes back.
      if (!inControl && this.tooLate(n)) { budget.refund(sec); this.addUsage(-sec); return; }
      const media = await saveMedia(n.mediaNode, isVideo ? 'video' : 'audio', n.id, this.mediaDir, { signal: this.abort.signal });
      if (!media) return;
      mark('downloaded');
      if (this.stopped) { deleteMediaFile(media); return; } // checkpoint: nothing leaves the box after stop()
      if (!await this.holdToRealLength(n, media, sec, isVideo)) { deleteMediaFile(media); return; }
      mark('measured');
      return this.metered(n, () => this.transcribeAndDeliver(m, n, chatName, media, isVideo, inControl));
    }));
    this.inFlight.add(job);
    try { return await job; } finally { this.inFlight.delete(job); }
  }

  /**
   * The length in the message is the sender's word, and a crafted client can call an hour of
   * audio one second. Before anything is uploaded the file itself is measured, and the
   * per-recording limit and both budgets are held against that. False = not to be transcribed.
   */
  async holdToRealLength(n, media, reserved, isVideo = false, measure = measureSeconds) {
    const limit = MAX_TRANSCRIBE_SECONDS || MAX_MEDIA_SECONDS;
    let real = await measure(media.absPath, { limitSeconds: limit });
    const giveBack = () => { budget.refund(reserved); this.addUsage(-reserved); };
    if (real == null) {
      // ffmpeg could not tell. A video it cannot read is not sent anywhere; for audio the file's
      // size still bounds the length (a voice note is 16 kbit/s or more, 2000 bytes a second).
      if (isVideo) { giveBack(); console.warn(`${this.tag} ⏭️ skipped a video whose length could not be measured`); return false; }
      let bytes = 0; try { bytes = statSync(media.absPath).size; } catch { /* gone */ }
      real = Math.max(n.seconds, bytes / 2000);
    }
    real = Math.ceil(real);
    if (MAX_TRANSCRIBE_SECONDS > 0 && real > MAX_TRANSCRIBE_SECONDS) {
      giveBack();
      console.log(`${this.tag} ⏭️ skipped a recording that is really over the ${MAX_TRANSCRIBE_SECONDS}s limit (it declared ${n.seconds}s)`);
      return false;
    }
    const extra = real - reserved;
    if (extra <= 5) return true; // what was reserved covers it
    if (!budget.reserve(extra)) { giveBack(); console.warn(`${this.tag} ⏸️ server daily audio budget reached — skipped`); return false; }
    if (!this.reserveUsage(extra)) { budget.refund(extra); giveBack(); console.log(`${this.tag} ⏸️ over daily cap, skipped`); return false; }
    n.seconds = real; // the sanity check and the logs work with the true length
    return true;
  }

  /**
   * One line per delivered recording: how long each step took, in seconds. "wa" is WhatsApp's
   * own delay (sent → arrived here; the sender's clock, whole seconds), "total" is ours
   * (arrived → text posted). Times only — nothing about what was said or to whom.
   */
  /**
   * One record per recording for the experiment: the arm, how the pipeline fared, how much
   * the corrector changed, speed, cost. Numbers only — the texts are measured here and
   * dropped. Written to the log and to DATA_DIR/experiments. Nothing when the experiment is off.
   * `run` is the brain's outcome (arm, armReason, model, retry, conf, raw).
   */
  recordExperiment(n, run, { isVideo, gate, posted, rewrite = null, raw = null, fixed = null }) {
    if (!experimentOn()) return;
    const t = n.t || {}, sec = (a, b) => (t[a] && t[b] ? Math.round((t[b] - t[a]) / 100) / 10 : null);
    const words = (x) => String(x || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).length;
    const rawW = raw != null ? words(raw) : words(run.raw ?? run.text);
    const rec = {
      kind: 'recording', at: Date.now(), acct: this.id, recId: n.id, arm: run.arm || 'A', reason: run.armReason || null, model: run.model,
      sec: n.seconds, video: !!isVideo, own: !!n.fromMe, lang: this.language || 'auto',
      rawWords: rawW, fixedWords: fixed != null ? words(fixed) : null, delta: raw != null && fixed != null ? experiments.wordDelta(raw, fixed) : null,
      wps: n.seconds ? Math.round((rawW / n.seconds) * 100) / 100 : null,
      gate, retry: run.retry || null, rewrite, fallback: run.arm?.includes('→A') ? run.armReason : null, posted,
      stt: sec('measured', 'transcribed'), fix: sec('transcribed', 'corrected'), total: sec('arrived', 'posted'),
      usd: bill()?.usd != null ? Math.round(bill().usd * 1e5) / 1e5 : null, conf: run.conf || null,
    };
    experiments.record(rec);
    console.log(`${this.tag} 🧪 arm=${rec.arm}${rec.reason ? `(${rec.reason})` : ''} sec=${rec.sec} ${rec.video ? 'video' : 'voice'}${rec.own ? ' own' : ''} lang=${rec.lang} raw=${rec.rawWords}w fixed=${rec.fixedWords ?? '–'}w delta=${rec.delta ?? '–'} gate=${rec.gate} retry=${rec.retry || '–'} rewrite=${rec.rewrite || '–'} stt=${rec.stt ?? '–'} fix=${rec.fix ?? '–'} total=${rec.total ?? '–'} usd=${rec.usd ?? '–'}${rec.conf ? ` conf=${rec.conf.minLogprob?.toFixed(2)}/${rec.conf.maxNoSpeech?.toFixed(2)}` : ''}`);
    if (posted) {
      const sender = n.fromMe ? 'me' : (n.senderIds?.[0] || n.chatId);
      this.abRecs.set(n.id, { arm: rec.arm, at: rec.at, chatId: n.chatId, sender });
      this.abLastPost.set(`${n.chatId}|${sender}`, { arm: rec.arm, at: rec.at, recId: n.id });
      for (const map of [this.abRecs, this.abLastPost]) while (map.size > 2000) map.delete(map.keys().next().value);
    }
  }

  /**
   * Corrections by voice (a pilot, voiceFix accounts only). Our transcript in a chat is remembered, in
   * memory, for FIX_WINDOW_MS (WhatsApp lets a message be edited for 15 minutes after it was sent).
   */
  /** Corrections by voice for this account: turned on for it, or for every account (features.js). */
  get voiceFixOn() { return this.voiceFix || feature('voiceFixAll'); }

  noteFixable(sent, n, prefix, body) {
    if (!this.voiceFixOn || !sent?.key?.id) return;
    // The recogniser's own text, before the clean-up, goes along: the clean-up may have changed the very word.
    n.fixKey = sent.key.id; // the research item, if one is kept, is attached to it once archived
    this.fixable.set(sent.key.id, { key: sent.key, chatId: n.chatId, prefix, body, raw: n.rawText || null, arm: n.arm || null, model: n.model || null, sec: n.seconds || null, at: Date.now(), fromMe: !!n.fromMe, speaker: n.fromMe ? [] : (n.senderIds || []) });
    while (this.fixable.size > 300) this.fixable.delete(this.fixable.keys().next().value);
  }

  /**
   * The post this message corrects, if it may: a voice note or a short typed text that replies to it,
   * in time, from the one who spoke the original.
   */
  fixTarget(n) {
    if (!this.voiceFixOn || n.forwarded) return null;
    const typed = !n.isVoice && n.type === 'chat' && n.body && String(n.body).trim().split(/\s+/).length <= FIX_TYPED_MAX_WORDS;
    const to = n.isVoice ? n.replyTo : typed ? n.quoted?.stanzaId : null;
    if (!to) return null;
    const p = this.fixable.get(to);
    if (!p || p.chatId !== n.chatId || Date.now() - p.at > FIX_WINDOW_MS) return null;
    const sameSpeaker = p.fromMe ? n.fromMe : (!n.fromMe && (n.senderIds || []).some((id) => p.speaker.includes(id)));
    return sameSpeaker ? p : null;
  }

  /**
   * Ask the brain whether the reply corrects the post; if it does, edit the post. True when edited.
   * One at a time per post, each against the text as it now is: two corrections in a row both land.
   */
  amendPost(p, reply, n, m = null) {
    const run = () => this.amendNow(p, reply, n, m);
    const next = (p.chain || Promise.resolve()).then(run, run);
    p.chain = next.catch(() => {});
    return next;
  }

  async amendNow(p, reply, n, m) {
    if (typeof brain.amend !== 'function' || Date.now() - p.at > FIX_WINDOW_MS) return false;
    const typed = !n.isVoice && n.seconds == null;
    const gap = Math.round((Date.now() - p.at) / 1000);
    // Numbers for every account (experiments.js); the texts only for an account that keeps recordings.
    // Which arm and model made the text that needed fixing, and how long its recording was: a correction is a
    // measure of that pipeline's quality, read per arm on the experiment page.
    const note = (outcome, extra = {}) => experiments.record({ kind: 'voicefix', outcome, at: Date.now(), acct: this.id, gap, own: !!n.fromMe, typed, arm: p.arm || 'A', model: p.model, recSec: p.sec, ...extra });
    const r = await brain.amend(p.body, reply, { raw: p.raw, trace: (e, d) => this.trace(e, d) }).catch(() => null);
    if (!r?.text) { note('not-a-correction'); console.log(`${this.tag} ✏️ a ${typed ? 'typed' : 'spoken'} reply to our text was not a correction (${gap}s after it)${typed ? '' : ' — delivered as a recording'}`); return false; }
    // Checked again: the time it took may have carried the edit past what WhatsApp still accepts.
    if (Date.now() - p.at > FIX_WINDOW_MS) { note('too-late'); console.log(`${this.tag} ✏️ a correction came too late to edit our text`); return false; }
    try {
      await this.sendPaced(p.chatId, { text: `${p.prefix}${r.text}`, edit: p.key });
    } catch (e) { note('edit-failed'); console.warn(`${this.tag} ✏️ correction found but the edit failed: ${firstLine(e)}`); return false; }
    const stats = experiments.correctionStats(p.body, r.text, p.raw);
    note('fixed', stats);
    if (this.keepAudio && p.item) research.annotate(this.id, p.item, { corrections: [{ at: Date.now(), gap, own: !!n.fromMe, reply, before: p.body, raw: p.raw, after: r.text, ...stats }] });
    this.trace('amended', { id: n.id, post: p.key.id, reply, text: r.text });
    // The text is now what its speaker said it is: the recogniser's old reading no longer helps a later
    // correction of the same post, and could only pull it back to the word just fixed.
    p.body = r.text; p.raw = null;
    // A mark on the correction itself: its speaker sees it was handled, and the others that it is only a fix.
    const mark = setting('fixReaction'); // the admin page sets it (features.js); '' = none
    if (m?.key && mark) this.sendMark(p.chatId, mark, m.key);
    console.log(`${this.tag} ✏️ transcript corrected by a ${typed ? 'typed' : 'spoken'} reply (${gap}s after it was posted · ${stats.changed} word(s) · ${stats.stage})`);
    return true;
  }

  /** A reaction of ours (🎙️, ✏️): its id is remembered, so the experiment does not count it as someone's reaction. */
  sendMark(jid, text, key) {
    return this.sendPaced(jid, { react: { text, key } })
      .then((sent) => { if (sent?.key?.id) { this.ownMarks.add(sent.key.id); while (this.ownMarks.size > 500) this.ownMarks.delete(this.ownMarks.values().next().value); } })
      .catch(() => {});
  }

  /** Our post that carries a recording's text: remembered so what people do with it can be counted. */
  notePost(sentId, n) {
    if (!sentId || !n?.arm || !experimentOn()) return;
    const r = this.abRecs.get(n.id);
    this.abPosts.set(sentId, { recId: n.id, arm: r?.arm || n.arm, at: Date.now(), chatId: n.chatId, sender: r?.sender || null });
    while (this.abPosts.size > 2000) this.abPosts.delete(this.abPosts.keys().next().value);
  }

  /**
   * What a message says about an earlier recording's text, before the message is otherwise
   * handled: a reaction on our post (or on the recording), our post deleted for everyone, a
   * reply to our post, or the same person recording again in the same chat within a minute.
   * Counted with the arm and the seconds since our text went out; never what was said.
   */
  noteSignal(m, n) {
    if (!experimentOn()) return;
    const content = unwrap(m.message); if (!content || content.viewOnce) return;
    const since = (at) => Math.round((Date.now() - at) / 100) / 10; // seconds, one decimal
    const say = (kind, on, hit, extra = {}) => {
      const rec = { kind, at: Date.now(), acct: this.id, arm: hit.arm, on, gap: since(hit.at), recId: hit.recId || null, ...extra };
      experiments.record(rec);
      console.log(`${this.tag} 🧪 ${kind} arm=${hit.arm} on=${on} gap=${rec.gap}s${extra.emoji ? ` emoji=${extra.emoji}` : ''}`);
    };
    const react = content.reactionMessage;
    if (react?.key?.id && m.key?.fromMe && this.ownMarks.has(m.key.id)) return; // our own 🎙️ / ✏️
    if (react?.key?.id) {
      const onPost = this.abPosts.get(react.key.id), onRec = this.abRecs.get(react.key.id);
      if (onPost) say('react', 'text', onPost, { emoji: String(react.text || '').slice(0, 8) || 'removed' });
      else if (onRec) say('react', 'recording', { ...onRec, recId: react.key.id }, { emoji: String(react.text || '').slice(0, 8) || 'removed' });
      return;
    }
    const proto = content.protocolMessage;
    if (proto && (proto.type === 0 || proto.type === 'REVOKE') && proto.key?.id) {
      const onPost = this.abPosts.get(proto.key.id), onRec = this.abRecs.get(proto.key.id);
      if (onPost) say('revoke', 'text', onPost);
      else if (onRec) say('revoke', 'recording', { ...onRec, recId: proto.key.id });
      return;
    }
    if (!n) return;
    if (this.fixTarget(n)) return; // a correction of our text (amendPost counts it): neither a reply nor a retake
    if (n.quoted?.stanzaId && this.abPosts.has(n.quoted.stanzaId) && n.type === 'chat') say('reply', 'text', this.abPosts.get(n.quoted.stanzaId));
    if (n.isVoice && !n.forwarded) {
      const sender = n.fromMe ? 'me' : (n.senderIds?.[0] || n.chatId);
      const last = this.abLastPost.get(`${n.chatId}|${sender}`);
      // Only within a minute of our text: that is a retake; anything later is the next message.
      if (last && Date.now() - last.at <= 60e3) say('rerecord', 'recording', last);
    }
  }

  /**
   * One line in the usage ledger (usage.js) per recording that reached this account: how long,
   * whose, what became of it, where its text went and how long it took. Numbers only.
   */
  noteUsage(n, isVideo, outcome, { reason = null, inControl = false } = {}) {
    const t = n.t || {};
    usage.record({
      acct: this.id, sec: n.seconds || 0, video: !!isVideo, own: !!(n.fromMe && !n.forwarded), outcome,
      ...(reason ? { reason: String(reason).split('(')[0].trim().slice(0, 40) } : {}),
      ...(outcome === 'delivered' ? { where: inControl ? 'control' : (n.route ?? this.route(n)) === 'me' ? 'me' : 'chat', total: t.arrived && t.posted ? Math.round((t.posted - t.arrived) / 100) / 10 : null } : {}),
    });
  }

  logTiming(n, isVideo, retry) {
    const t = n.t, s = (a, b) => (t[a] && t[b] ? ((t[b] - t[a]) / 1000).toFixed(1) : '–');
    const start = t.claimed || t.arrived;
    const wa = t.sentAt ? Math.max(0, (t.arrived - t.sentAt) / 1000).toFixed(0) : '–';
    console.log(`${this.tag} ⏱️ ${n.seconds}s ${isVideo ? 'video' : 'voice'}${n.fromMe ? ' (own)' : ''}: wa ${wa} · claim ${s('arrived', 'claimed')} · queue ${(((t.slot || start) - start) / 1000).toFixed(1)} · download ${s('slot', 'downloaded')} · measure ${s('downloaded', 'measured')} · stt ${s('measured', 'transcribed')}${retry ? ` (${retry} retry)` : ''} · fix ${s('transcribed', 'corrected')} · send ${s('corrected', 'posted')} · total ${s('arrived', 'posted')}s`);
  }

  /** Everything one recording sets off is billed to it, and the bill added to this account's total (dollars, no content). */
  metered(n, fn) {
    return meter(n.seconds, async () => {
      try { return await fn(); } finally {
        const b = bill();
        if (b?.usd > 0) { this.totals.usd = (this.totals.usd || 0) + b.usd; if (b.unpriced) this.totals.unpriced = true; saveJson(this.f('totals.json'), this.totals); }
      }
    });
  }

  async transcribeAndDeliver(m, n, chatName, media, isVideo, inControl) {
    if (this.stopped) { deleteMediaFile(media); return; } // checkpoint before anything is uploaded
    const plan = planEnabled(this.plan) ? this.plan : (planEnabled('pro') ? 'pro' : 'free');
    // Filled in as we go; only used when this account opted in to keeping audio.
    const keep = { seconds: n.seconds, isVideo, fromMe: n.fromMe, plan, language: this.language || 'auto' };
    // The brain gets the audio as a buffer (a video's track extracted here), never a path.
    const { audio, cleanup } = await prepareAudio(media.absPath, isVideo);
    try {
      const who = { speaker: n.senderName, isMe: n.fromMe };
      const names = await this.namesFor(n);
      const out = await brain.process({
        audio, seconds: n.seconds, isVideo, plan, language: this.language || '', ...who, names,
        fingerprint: n.mediaSha || n.id, compareModels: this.abModel || null, shadow: this.keepAudio,
        signal: this.abort.signal, onStage: (stage) => { if (n.t) n.t[stage] = Date.now(); },
      });
      n.arm = out.arm || 'A';
      if (out.arm && out.arm !== 'A' && out.arm.endsWith('→A')) console.log(`${this.tag} 🧪 ${out.arm} (${out.armReason})`);
      if (this.stopped || (out.dropped === 'empty' && !out.raw)) return;
      Object.assign(keep, { model: out.model, text: out.raw, usedFallback: out.usedFallback, check: out.dropped ? { ok: false, reason: out.dropped } : { ok: true }, retry: out.retry, compare: out.compare, arm: out.arm || 'A', armReason: out.armReason || null });
      if (out.retry) console.log(`${this.tag} 🔁 "${out.language || 'auto'}" came back in another script — the ${out.retry} retry answered`);
      if (out.usedFallback) console.warn(`${this.tag} ⚠️ ${planLabel(plan)} failed — the fallback host answered`);
      if (out.dropped) {
        this.stats.dropped++;
        console.warn(`${this.tag} 🚫 dropped likely hallucination (${out.dropped}) on a ${n.seconds}s ${isVideo ? 'video' : 'voice note'}`);
        if (inControl) this.sendPaced(n.chatId, { text: "🤷 Couldn't make out any speech in that recording." }, { quoted: m }).catch(() => {});
        this.recordExperiment(n, out, { isVideo, gate: out.dropped, posted: false });
        this.noteUsage(n, isVideo, 'dropped', { reason: out.dropped });
        return;
      }
      const content = out.text, summary = out.summary || null, rewritten = out.fix?.text || null;
      Object.assign(keep, { rewritten, summary });
      const body = summary ? `*${summary}*\n${content}` : content;
      this.trace('transcribed', { id: n.id, seconds: n.seconds, inControl: !!inControl, fromMe: n.fromMe, forwarded: n.forwarded, isGroup: n.isGroup, model: out.model, raw: out.raw, alts: out.alts, rewritten, summary });
      this.stats.transcribed++;
      const whose = n.fromMe && !n.forwarded ? 'own' : 'others';
      this.totals[whose]++; this.totals[`${whose}Seconds`] = (this.totals[`${whose}Seconds`] || 0) + n.seconds;
      saveJson(this.f('totals.json'), this.totals);
      this.cacheText(n.mediaSha, content, summary);
      console.log(`${this.tag} ${isVideo ? '🎬' : '🎙️'} ${n.seconds}s → ${content.length} chars${summary ? ' + summary' : ''} [${plan}]`);
      if (n.fixOf && await this.amendPost(n.fixOf, out.raw || content, n, m)) { if (n.t) n.t.posted = Date.now(); return true; }
      n.rawText = out.raw || null; n.model = out.model || null; // kept with the post for a correction (noteFixable), in memory only
      let posted = false;
      if (inControl) await this.handleControlNote(n, content, body, isVideo, m);
      else posted = await this.deliver(n, chatName, body, isVideo, m);
      if (n.t) { n.t.posted = Date.now(); this.logTiming(n, isVideo, out.retry); }
      this.recordExperiment(n, out, { isVideo, gate: 'ok', posted: !!(posted || inControl), rewrite: out.fix?.reason || null, raw: out.raw, fixed: content });
      this.noteUsage(n, isVideo, 'delivered', { inControl });
      // What runs after the text is out, so nobody waited for it: the other pipelines on an
      // account that keeps audio, or an admin's A/B list. Their texts are kept beside the
      // delivered one; the owner's own group gets the comparison when it is one that should.
      if (out.later && !this.stopped) {
        const { compare, report } = await out.later();
        keep.compare = compare;
        const wants = Boolean(this.abModel) || Boolean(INFO.experiment?.reportAccounts?.has(this.id));
        if (report && wants && this.target && !this.stopped) this.sendPaced(this.target.jid, { text: report }).catch(() => {});
      }
      return posted;
    } catch (e) {
      this.stats.failed++; this.lastError = { at: Date.now(), message: firstLine(e) };
      console.warn(`${this.tag} ⚠️ transcription failed: ${firstLine(e)}`);
      keep.error = firstLine(e);
      this.noteUsage(n, isVideo, 'failed', { reason: firstLine(e).split(':')[0] });
    } finally {
      cleanup();
      // Opted in: the recording is kept with what the models made of it, so a
      // model change can be judged on real audio. Otherwise it is deleted now.
      const item = this.keepAudio ? research.archive({ accountId: this.id, mediaPath: media.absPath, meta: keep }) : null;
      if (item) console.log(`${this.tag} 🎧 kept the recording for product work`);
      if (item && n.fixKey && this.fixable.has(n.fixKey)) this.fixable.get(n.fixKey).item = item; // a later spoken correction joins it
      else deleteMediaFile(media);
    }
  }

  /**
   * Full trace of what happened to a recording — transcript, the model's
   * reading of it, who it matched, what was sent. ONLY for an account whose
   * owner opted in to keeping data for product work; silent for everyone else.
   */
  trace(event, data = {}) {
    if (!this.keepAudio) return;
    console.log(`${this.tag} 🔬 ${event} ${JSON.stringify(data)}`);
  }

  /** One notice per calendar day per kind, into the control group. */
  notifyOncePerDay(kind, text) {
    const day = this.todayKey();
    this.notices = this.notices || {};
    if (this.notices[kind] === day || !this.target) return;
    this.notices[kind] = day;
    this.sendPaced(this.target.jid, { text }).catch(() => {});
  }

  // ---------- delivery ----------
  /** Resolves true once the text is in the chat (another account may be waiting to hear). */
  deliver(n, chatName, text, isVideo, original) {
    if (this.stopped) return false;
    if ((n.route ?? this.route(n)) === 'me') return this.deliverPrivate(n, chatName, text, isVideo);
    const body = n.fromMe ? `${SELF_PREFIX}${text}` : `${isVideo ? '🎬' : '🎙️'} *${n.senderName || chatName || 'unknown'}*: ${text}`;
    // In a disappearing chat the text disappears on the same timer as the recording.
    const opts = { quoted: original, ...(n.expiration ? { ephemeralExpiration: n.expiration } : {}) };
    return this.sendPaced(n.chatId, { text: body }, opts)
      .then((sent) => {
        this.notePost(sent?.key?.id, n); this.noteFixable(sent, n, body.slice(0, body.length - text.length), text);
        // A mark on the recording that matches the text's own (features.js; '' = none). Only here, where
        // the text is in the chat: an account that keeps its texts to itself shows the chat nothing, and the
        // owner's own Ramble group, where the text sits right under the recording, needs no mark.
        const mark = setting('transcribedReaction');
        if (mark && original?.key && n.chatId !== this.target?.jid) this.sendMark(n.chatId, mark, original.key);
        console.log(`${this.tag} 📝 posted ${n.fromMe ? 'own' : 'their'} transcript (${n.isGroup ? 'group' : 'private'})`); return true; })
      .catch((e) => { console.warn(`${this.tag} post failed: ${firstLine(e)}`); return false; });
  }

  /**
   * Private mode: the text goes to the control group as a message of its own, nothing to the chat.
   * Replying include / exclude / private to it switches that chat, and delete removes it.
   */
  deliverPrivate(n, chatName, text, isVideo) {
    if (!this.target) return false;
    const he = this.ownerLocale() === 'he', icon = isVideo ? '🎬' : '🎙️';
    const sender = n.senderName || chatName || 'unknown';
    // Theirs: who, and in which group. The owner's own: where it went.
    const head = n.fromMe
      ? (he ? `${icon} ההקלטה שלך ${n.isGroup ? 'ב' : 'ל'}*${chatName}*` : `${icon} *You* ${n.isGroup ? 'in' : 'to'} *${chatName}*`)
      : `${icon} *${sender}*${n.isGroup && chatName ? ` ${he ? 'ב' : 'in '}*${chatName}*` : ''}`;
    return this.sendPaced(this.target.jid, { text: `${head}\n${text}` })
      .then((sent) => {
        if (sent?.key?.id) this.recordFwd(sent.key.id, { chatId: n.chatId, name: chatName || sender });
        this.notePost(sent?.key?.id, n);
        console.log(`${this.tag} 📝 private transcript (${n.isGroup ? 'group' : 'private'})`);
        return false; // not a post in the chat: nobody else's text there depends on it
      })
      .catch((e) => { console.warn(`${this.tag} private post failed: ${firstLine(e)}`); return false; });
  }

  /** A recording forwarded into the control group: its text + whether its source chat is on or off. */
  deliverProbe(n, body, isVideo, original) {
    if (this.stopped) return;
    const src = n.mediaSha ? this.mediaSrc.get(n.mediaSha) : null;
    let tail;
    if (!src) tail = "_(Couldn't tell which chat this came from — only recordings I saw arrive can be traced.)_";
    else {
      const mode = this.chatMode(src.chatId), nm = src.name;
      tail = this.ownerLocale() === 'he'
        ? { included: `🟢 מתומלל: *«${nm}»*, והטקסט מופיע בצ'אט. לענות *private* כדי לקבל אותו רק כאן, או *exclude* כדי להפסיק.`,
          private: `🔒 מתומלל בפרטיות: *«${nm}»*. הטקסט מגיע לכאן, ושום דבר לא נכתב שם. לענות *include* כדי שיופיע בצ'אט, או *exclude* כדי להפסיק.`,
          mine: `🟡 רק ההודעות הקוליות שלך מתומללות ב*«${nm}»*. לענות *include* כדי לתמלל את כולם, *private* כדי לקבל הכול רק כאן, או *exclude* כדי להפסיק.`,
          off: `🔇 לא מתומלל: *«${nm}»*. לענות *include* כדי לקבל טקסט בצ'אט, או *private* כדי לקבל אותו רק כאן.` }[mode]
        : { included: `🟢 *«${nm}»* is transcribed, with the text in the chat. Reply *private* to get it only here, or *exclude* to stop.`,
          private: `🔒 *«${nm}»* is transcribed privately: the text comes here and nothing is posted there. Reply *include* to post it in the chat, or *exclude* to stop.`,
          mine: `🟡 *«${nm}»*: only your own voice notes are transcribed. Reply *include* for everyone's, *private* to get everything only here, or *exclude* to stop.`,
          off: `🔇 *«${nm}»* is not transcribed. Reply *include* to get the text in the chat, or *private* to get it only here.` }[mode];
    }
    this.sendPaced(this.target.jid, { text: `${isVideo ? '🎬' : '🎙️'} ${src ? `from *${src.name}*` : 'forwarded recording'}\n${body}\n\n${tail}` }, { quoted: original })
      .then((sent) => { if (src && sent?.key?.id) this.recordFwd(sent.key.id, src); })
      .catch((e) => console.warn(`${this.tag} probe post failed: ${firstLine(e)}`));
  }

  // ---------- dictated messages ----------
  /**
   * A recording in the control group. A forwarded one (or one we saw arrive
   * elsewhere) is a probe of its chat. A voice note recorded right here may be
   * a dictated message: "send Eden that I'm on my way". If it is not one, or
   * the model cannot tell, it is treated as a probe like before.
   */
  async handleControlNote(n, content, body, isVideo, original) {
    // Only the owner's own voice can dictate or answer: should anyone else ever be in this group,
    // their recordings are transcribed like any forwarded one and nothing more.
    if (!n.fromMe) { this.deliverProbe(n, body, isVideo, original); return; }
    const traceable = !!(n.mediaSha && this.mediaSrc.has(n.mediaSha));
    // A question of ours is open and the owner answered it out loud ("yes", "כן", "שתיים").
    if (!traceable && !n.forwarded && n.isVoice && this.pendingSend && await this.handleDictationReply(original, n, spokenAnswer(content))) return;
    if (!traceable && !n.forwarded && n.isVoice && this.pendingSwitch && await this.handleSwitchReply(original, n, spokenAnswer(content))) return;
    const cue = looksLikeDictation(content);
    this.trace('control.note', { id: n.id, traceable, forwarded: n.forwarded, isVoice: n.isVoice, cue });
    if (!traceable && !n.forwarded && n.isVoice && cue) {
      const d = await this.dictationFor(content);
      this.trace('dictation.extracted', { id: n.id, result: d });
      if (d && !this.stopped) { await this.dictate(d, original); return; }
    }
    // Recorded right here, not forwarded: it is the owner's own note, and gets its text like one.
    // The first one is the last step of onboarding: say that this is it, and what to do next.
    if (!traceable && !n.forwarded && n.isVoice) {
      const posted = await this.deliver(n, 'me', content, isVideo, original);
      if (posted && !this.firstNoteAt && !this.stopped) {
        this.firstNoteAt = Date.now(); this.persistRecord();
        if (Date.now() - (this.linkedAt || 0) < 7 * 86400e3) {
          await this.sendPaced(n.chatId, { text: this.ownerLocale() === 'he'
            ? "👏 ככה זה עובד: כל הודעה קולית שנשלחת ממך מקבלת טקסט ממש מתחתיה, בכל צ'אט.\nעכשיו לשלוח אחת למישהו, בצ'אט פרטי."
            : "👏 That's how it works: every voice note you send gets its text right under it, in any chat.\nNow send one to someone, in a private chat." }).catch(() => {});
        }
      }
      return;
    }
    this.deliverProbe(n, body, isVideo, original);
  }
  dictationFor(text) { return brain.dictation(text, { trace: (e, d) => this.trace(e, d) }); }

  /**
   * Resolve the recipient and ASK. Nothing is ever sent on the strength of a
   * match alone: even one certain saved contact is only proposed, with the end
   * of their number, and goes out when the owner replies yes. Several possible
   * contacts are listed and picked by number.
   */
  async dictate({ to, spellings = [], text }, original) {
    const { proposed: certain, candidates } = matchContacts([to, ...spellings], this.contactNames, { activity: this.activity });
    this.trace('dictation.match', { to, spellings, text, proposed: certain, candidates, contacts: this.contactNames.size });
    const quoted = original ? { quoted: original } : {};
    if (!candidates.length) {
      console.log(`${this.tag} ✉️ dictation: no contact matched — nothing sent`);
      this.noteCommand('dictate', 'no contact matched');
      await this.sendPaced(this.target.jid, { text: `🤷 Couldn't find *${to}* in your contacts, so nothing was sent. If the spelling is off, *names: ${to}* in Notes to self teaches me.` }, quoted).catch(() => {});
      return;
    }
    // The proposed one first, so that "yes" and "1" mean the same person.
    const list = certain ? [certain, ...candidates.filter((c) => c.jid !== certain.jid)] : candidates;
    const tail = (jid) => (jid.endsWith('@s.whatsapp.net') ? ` (…${jid.split('@')[0].slice(-4)})` : '');
    const label = (c) => `${c.name}${tail(c.jid)}`;
    console.log(`${this.tag} ✉️ dictation: ${list.length} possible contact(s) — asking before sending`);
    const others = list.length > 1 ? `\n\nSomeone else? Reply with the number:\n${list.map((c, i) => `${i + 1}. ${label(c)}`).join('\n')}` : '';
    const ask = certain
      ? `✉️ Send to *${label(certain)}*?\n«${text}»\n\nReply *yes* to send, *no* to drop it — typed or spoken.${others}`
      : `🤔 Not sure who *${to}* is:\n${list.map((c, i) => `${i + 1}. ${label(c)}`).join('\n')}\n\nReply with the number to send them:\n«${text}»\n\nReply *no* to drop it.`;
    this.noteCommand('dictate', certain ? 'asked to confirm' : `asked to pick (${list.length})`);
    const sent = await this.sendPaced(this.target.jid, { text: ask }, quoted).catch(() => null);
    this.pendingLeave = null; this.pendingSwitch = null; // the newest question owns the next "yes"
    this.pendingSend = { postId: sent?.key?.id || null, candidates: list, proposed: !!certain, text, at: Date.now() };
  }

  /** Send the message as the owner, then confirm in the control group with an undo handle. */
  async sendDictated(contact, text, original) {
    if (this.stopped) return;
    let sent;
    try { sent = await this.sendPaced(contact.jid, { text }); }
    catch (e) {
      console.warn(`${this.tag} ✉️ dictated message failed: ${firstLine(e)}`);
      this.trace('dictation.send_failed', { jid: contact.jid, name: contact.name, text, error: firstLine(e) });
      this.noteCommand('dictate', 'sending failed');
      await this.sendPaced(this.target.jid, { text: `⚠️ Couldn't send to *${contact.name}*. Nothing was sent.` }).catch(() => {});
      return;
    }
    console.log(`${this.tag} ✉️ sent a dictated message (${text.length} chars)`);
    this.trace('dictation.sent', { jid: contact.jid, name: contact.name, text, messageId: sent?.key?.id || null });
    this.noteCommand('dictate', 'sent');
    const conf = await this.sendPaced(this.target.jid, { text: `✉️ Sent to *${contact.name}*:\n«${text}»\n\nReply *undo* to delete it for everyone.` }, original ? { quoted: original } : {}).catch(() => null);
    if (conf?.key?.id && sent?.key?.id) {
      this.dictated.set(conf.key.id, { chatId: contact.jid, id: sent.key.id });
      while (this.dictated.size > 200) this.dictated.delete(this.dictated.keys().next().value);
    }
  }

  /** Control-group text that answers a dictation: a number picks the recipient, undo/cancel drops or revokes. */
  async handleDictationReply(m, n, lower) {
    if (this.ownPosts.has(n.id)) return false; // our own post echoing back is never an answer
    const undo = n.quoted ? this.dictated.get(n.quoted.stanzaId) : null;
    if (undo || this.pendingSend) this.trace('dictation.reply', { said: lower.slice(0, 40), quoted: n.quoted?.stanzaId || null, undo: !!undo, pending: this.pendingSend ? { postId: this.pendingSend.postId, candidates: this.pendingSend.candidates, ageMs: Date.now() - this.pendingSend.at } : null });
    if (undo && lower === 'undo') {
      this.dictated.delete(n.quoted.stanzaId);
      try {
        await this.sock.sendMessage(undo.chatId, { delete: { remoteJid: undo.chatId, fromMe: true, id: undo.id } });
        this.noteCommand('undo', 'done');
        await this.sendPaced(n.chatId, { text: '↩️ Deleted it for everyone.' }, { quoted: m }).catch(() => {});
      } catch (e) {
        console.warn(`${this.tag} undo failed: ${firstLine(e)}`);
        this.noteCommand('undo', 'failed');
        await this.sendPaced(n.chatId, { text: "⚠️ Couldn't delete it — remove it in the chat yourself." }, { quoted: m }).catch(() => {});
      }
      return true;
    }
    const p = this.pendingSend;
    if (!p || Date.now() - p.at > PENDING_SEND_TTL_MS || (n.quoted && n.quoted.stanzaId !== p.postId)) return false;
    if (lower === 'no') {
      this.pendingSend = null;
      this.noteCommand('dictate', 'cancelled');
      await this.sendPaced(n.chatId, { text: '👌 Dropped. Nothing was sent.' }, { quoted: m }).catch(() => {});
      return true;
    }
    const pick = /^\d{1,2}$/.test(lower) ? p.candidates[Number(lower) - 1] : (p.proposed && lower === 'yes' ? p.candidates[0] : null);
    if (!pick) return false;
    this.pendingSend = null;
    await this.sendDictated(pick, p.text, m);
    return true;
  }

  /** "leave" in the control group asks; a typed yes unlinks the device and erases the account. */
  async handleLeave(m, n, lower) {
    if (this.ownPosts.has(n.id)) return false;
    const he = this.ownerLocale() === 'he';
    if (lower === 'leave') {
      this.pendingSend = null; this.pendingSwitch = null;
      this.noteCommand('leave', 'asked to confirm');
      const sent = await this.sendPaced(n.chatId, { text: he
        ? `⚠️ לנתק את *${PRODUCT_NAME}* מהוואטסאפ שלך ולמחוק את כל מה ששמור עליך כאן?\n\nלענות *yes* כדי להתנתק, *no* כדי להמשיך כרגיל.`
        : `⚠️ Unlink *${PRODUCT_NAME}* from your WhatsApp and erase everything about you here?\n\nReply *yes* to leave, *no* to carry on.` }, { quoted: m }).catch(() => null);
      this.pendingLeave = { postId: sent?.key?.id || null, at: Date.now() };
      return true;
    }
    const p = this.pendingLeave;
    if (!p || Date.now() - p.at > PENDING_LEAVE_TTL_MS || (n.quoted && n.quoted.stanzaId !== p.postId)) return false;
    if (lower === 'no') {
      this.pendingLeave = null;
      this.noteCommand('leave', 'cancelled');
      await this.sendPaced(n.chatId, { text: he ? '👌 נשארים. שום דבר לא השתנה.' : '👌 Staying. Nothing changed.' }, { quoted: m }).catch(() => {});
      return true;
    }
    if (lower !== 'yes') return false;
    this.pendingLeave = null;
    console.log(`${this.tag} 👋 owner asked to leave from the control group`);
    this.noteCommand('leave', 'done');
    await this.sendPaced(n.chatId, { text: he
      ? `👋 בוצע. *${PRODUCT_NAME}* מתנתק מהוואטסאפ שלך וכל מה שנשמר עליך כאן נמחק. אם הוא עדיין מופיע תחת *מכשירים מקושרים*, אפשר להסיר אותו שם. את הקבוצה הזו אפשר למחוק.`
      : `👋 Done. *${PRODUCT_NAME}* is unlinking from your WhatsApp and everything about you here is erased. If it still shows under *Linked devices*, remove it there. You can delete this group.` }).catch(() => {});
    await this.onLeave?.(this);
    return true;
  }

  // ---------- include / exclude a chat ----------
  /** True when this recording's chat was excluded by the owner, under either of its ids. */
  isExcluded(n) { return this.muted.has(n.chatId) || (!!n.chatAlt && this.muted.has(n.chatAlt)); }
  /** True when this recording's chat is in private mode, under either of its ids. */
  isQuiet(n) { return this.quiet.has(n.chatId) || (!!n.chatAlt && this.quiet.has(n.chatAlt)); }
  /** True when this recording's chat was included by the owner, under either of its ids. */
  isIncluded(n) { return this.enabled.has(n.chatId) || (!!n.chatAlt && this.enabled.has(n.chatAlt)); }
  /** Whether this chat is among the ones picked on the settings page (always, when none were picked). Notes to self always is. */
  isChosen(n, section) {
    if (!section.some.length || this.isSelfChat(n.chatId)) return true;
    return [n.chatId, n.chatAlt, this.altIds.get(n.chatId)].some((id) => id && section.some.includes(id));
  }
  /**
   * Where one recording's text goes: 'chat' (under it), 'me' (the control group only), or null (not
   * transcribed). The control group is always 'chat'. Then, in order: excluded chats get nothing, not
   * even the owner's own notes; other people's recordings in archived chats are left alone; a chat in
   * private mode is everyone's, to me; an included chat is everyone's, in the chat; everything else
   * follows the settings. (Choosing "only to me" on the settings page moves included chats to private mode.)
   */
  route(n) {
    if (this.target?.jid && n.chatId === this.target.jid) return 'chat';
    if (this.isExcluded(n)) return null;
    if (!n.fromMe && this.archived.has(n.chatId)) return null;
    if (this.isQuiet(n)) return 'me';
    if (this.isIncluded(n)) return 'chat';
    const section = this.settings[n.isGroup ? 'groups' : 'chats'];
    return decide(section, { fromMe: n.fromMe, chosen: this.isChosen(n, section) });
  }
  /** Private delivery for this recording. */
  isPrivateHere(n) { return this.route(n) === 'me'; }
  /** What happens in this chat: 'included' (everyone's, text in the chat), 'private' (everyone's, text here), 'mine' (the owner's own only), or 'off'. */
  chatMode(chatId) {
    if (this.muted.has(chatId)) return 'off';
    if (this.quiet.has(chatId)) return 'private';
    const n = { chatId, chatAlt: null, isGroup: chatId.endsWith('@g.us') }, section = this.settings[n.isGroup ? 'groups' : 'chats'];
    const theirs = this.enabled.has(chatId) ? 'chat' : decide(section, { fromMe: false, chosen: this.isChosen(n, section) });
    if (theirs) return theirs === 'me' ? 'private' : 'included';
    return decide(section, { fromMe: true, chosen: this.isChosen(n, section) }) ? 'mine' : 'off';
  }
  /** Whether other people's recordings in this chat get their text in the chat. */
  chatIncluded(chatId) { return this.chatMode(chatId) === 'included'; }
  /** What happens in groups nobody switched, in the words of the "groups" command: off, mine, all or private. */
  get groups() { return groupsMode(this.settings); }
  set groups(mode) { this.settings = setGroupsMode(this.settings, mode); }

  /** Every id WhatsApp may use for this private chat: the phone id and the lid, when the mapping is known. */
  async chatIdsFor(jid) {
    const ids = new Set([jid]);
    if (jid.endsWith('@g.us')) return [...ids];
    if (this.altIds.get(jid)) ids.add(this.altIds.get(jid));
    const map = this.sock?.signalRepository?.lidMapping;
    try {
      if (jid.endsWith('@lid')) { const pn = await map?.getPNForLID(jid); if (pn) ids.add(jidNormalizedUser(pn)); }
      else { const lid = await map?.getLIDForPN(jid); if (lid) ids.add(jidNormalizedUser(lid)); }
    } catch { /* mapping unavailable: the id we have still counts */ }
    return [...ids];
  }

  /** Contacts and groups the owner can name, as jid → name. Never the control group or Notes to self. */
  async switchDirectory() {
    if (this.sock?.groupFetchAllParticipating && (!this._groupsAt || Date.now() - this._groupsAt > 10 * 60e3)) {
      try {
        const all = await this.sock.groupFetchAllParticipating();
        for (const [jid, meta] of Object.entries(all || {})) {
          if (meta?.subject) this.groupNames.set(jid, meta.subject);
          if (Array.isArray(meta?.participants)) this.groupSizes.set(jid, meta.participants.length);
          if (meta?.isCommunity) this.communities.add(jid); else this.communities.delete(jid);
        }
        this._groupsAt = Date.now();
      } catch { /* offline: the groups seen so far */ }
    }
    const dir = new Map();
    for (const [jid, name] of this.contactNames) if (name && !this.isSelfChat(jid)) dir.set(jid, name);
    for (const [jid, name] of this.groupNames) if (name && jid !== this.target?.jid) dir.set(jid, name);
    return dir;
  }

  /**
   * The chats a typed name may mean, one option per chat. Different people who share a name stay
   * separate options, told apart by the end of their number; the phone id and the lid of the same
   * person are one option.
   */
  async switchOptions(name) {
    const dir = await this.switchDirectory();
    const { candidates } = matchContacts(name, dir, { activity: this.activity, max: 8 });
    // One option per person, across every name they matched under (their saved name and the one they
    // gave themselves can both match), labelled with the name the owner saved them under when known.
    const people = [];
    const savedName = (ids) => ids.map((id) => (this.savedNames.has(id) ? this.contactNames.get(id) : null)).find(Boolean) || null;
    for (const c of candidates) {
      // matchContacts folds everything with the same name into one; unfold it into the chats behind it.
      const same = [...dir].filter(([, v]) => normName(v) === normName(c.name)).map(([jid]) => jid);
      for (const jid of same) {
        const ids = await this.chatIdsFor(jid);
        const known = people.find((p) => p.ids.some((id) => ids.includes(id)));
        if (known) { for (const id of ids) if (!known.ids.includes(id)) known.ids.push(id); if (jid.endsWith('@s.whatsapp.net')) known.chatId = jid; }
        else people.push({ chatId: jid, ids, name: String(dir.get(jid)).trim(), isGroup: jid.endsWith('@g.us') });
      }
    }
    for (const p of people) if (!p.isGroup) p.name = String(savedName(p.ids) || p.name).trim();
    return people.slice(0, 9);
  }

  /**
   * "exclude 050-123-4567" / "+44 7700 900123": the private chat with that number — for a business
   * or anyone whose name was never seen. Known chats whose number ends the same way come first;
   * otherwise WhatsApp is asked whether the full number has an account.
   */
  async switchByNumber(raw) {
    let digits = raw.replace(/\D/g, '');
    const intl = /^\s*(\+|00)/.test(raw);
    if (intl) digits = digits.replace(/^00/, '');
    const tail = digits.replace(/^0+/, '').slice(-9);
    if (tail.length < 6) return [];
    const known = new Set([...this.contactNames.keys(), ...this.activity.keys(), ...this.altIds.keys(), ...[...this.mediaSrc.values()].map((v) => v.chatId)]);
    let hits = [...known].filter((j) => j.endsWith('@s.whatsapp.net') && j.split('@')[0].endsWith(tail));
    if (!hits.length && this.sock?.onWhatsApp) {
      // A local number takes the owner's own country code — only when the owner's number shows it plainly.
      const cc = (this.ownId || '').match(/^(972|44|1)/)?.[1];
      const full = intl ? digits : digits.startsWith('0') && cc ? cc + digits.replace(/^0+/, '') : null;
      if (full) try { const [r] = await this.sock.onWhatsApp(full); if (r?.exists && r.jid) hits = [jidNormalizedUser(r.jid)]; } catch { /* lookup unavailable */ }
    }
    const options = [];
    for (const jid of new Set(hits)) options.push({ chatId: jid, ids: await this.chatIdsFor(jid), name: this.contactNames.get(jid) || `+${jid.split('@')[0]}`, isGroup: false });
    return options.slice(0, 9);
  }

  switchLabel(o) {
    const he = this.ownerLocale() === 'he';
    if (o.isGroup) return `${o.name} (${he ? 'קבוצה' : 'group'})`;
    const phone = o.ids.find((id) => id.endsWith('@s.whatsapp.net'));
    return phone ? `${o.name} (…${phone.split('@')[0].slice(-4)})` : o.name;
  }

  /** "include Mom" / "exclude Mom", or either word as a reply to a forwarded recording: find the chat, then ask. */
  async askSwitch(m, n, action, name) {
    const he = this.ownerLocale() === 'he';
    let options;
    if (!name && n.quoted) {
      const src = this.resolveQuotedSource(n.quoted.stanzaId, n.quoted);
      options = src ? [{ chatId: src.chatId, ids: await this.chatIdsFor(src.chatId), name: src.name, isGroup: src.chatId.endsWith('@g.us') }] : [];
      if (!options.length) {
        this.noteCommand(action, 'could not tell which chat');
        await this.sendPaced(n.chatId, { text: he ? `🤷 לא ברור על איזה צ'אט מדובר. לכתוב *${action}* ואת השם.` : `🤷 Couldn't tell which chat that's about. Write *${action}* and the name.` }, { quoted: m }).catch(() => {});
        return;
      }
    } else if (!name) {
      this.noteCommand(action, 'shown what is switched');
      await this.sendPaced(n.chatId, { text: this.switchStatus(action) }, { quoted: m }).catch(() => {});
      return;
    } else options = /^[+\d][\d\s()-]{5,}$/.test(name) ? await this.switchByNumber(name) : await this.switchOptions(name);
    this.trace('switch.match', { action, name, options: options.map((o) => ({ chatId: o.chatId, ids: o.ids, name: o.name })) });
    if (!options.length) {
      this.noteCommand(action, /^[+\d]/.test(name) ? 'no chat with that number' : 'no chat with that name');
      await this.sendPaced(n.chatId, { text: he
        ? `🤷 לא מצאתי איש קשר או קבוצה בשם *${name}*. שום דבר לא השתנה.\nאפשר לכתוב את המספר במקום השם (*${action} 050-1234567*), או להעביר לכאן הודעה קולית מהצ'אט ולענות לה *${action}*.`
        : `🤷 No contact or group called *${name}*. Nothing changed.\nWrite the number instead of the name (*${action} +1 555 123 4567*), or forward a voice note from that chat to here and reply *${action}* to it.` }, { quoted: m }).catch(() => {});
      return;
    }
    this.pendingSend = null; this.pendingLeave = null; // the newest question owns the next "yes"
    if (options.length === 1) { await this.confirmSwitch(m, n.chatId, action, options, options[0]); return; }
    const list = options.map((o, i) => `${i + 1}. ${this.switchLabel(o)}`).join('\n');
    this.noteCommand(action, `asked to pick (${options.length})`);
    const sent = await this.sendPaced(n.chatId, { text: he
      ? `🤔 למי הכוונה?\n${list}\n\nלענות במספר, או *no* כדי לבטל.`
      : `🤔 Which one?\n${list}\n\nReply with the number, or *no* to cancel.` }, { quoted: m }).catch(() => null);
    this.pendingSwitch = { postId: sent?.key?.id || null, action, options, chosen: null, at: Date.now() };
  }

  /** The last step, always: name the one chat that would change, and wait for a yes. */
  async confirmSwitch(m, chatId, action, options, chosen) {
    const he = this.ownerLocale() === 'he';
    const label = this.switchLabel(chosen);
    const text = action === 'private'
      ? (he ? `🔒 לתמלל את *${label}* בפרטיות?\nכל הקלטה בצ'אט ההוא תתומלל, גם שלך, והטקסט יגיע רק לקבוצה הזו. שום דבר לא ייכתב בצ'אט ההוא.\n\nלענות *yes* כדי לעבור, *no* כדי לבטל.`
        : `🔒 Transcribe *${label}* privately?\nEvery recording there will be transcribed, yours included, and the text will come only to this group. Nothing is posted in that chat.\n\nReply *yes* to switch, *no* to cancel.`)
      : action === 'exclude'
      ? (he ? `🔇 להחריג את *${label}*?\nשום הקלטה בצ'אט הזה לא תתומלל, גם לא ההקלטות שלך.\n\nלענות *yes* כדי להחריג, *no* כדי לבטל.`
        : `🔇 Exclude *${label}*?\nNo recording in this chat will be transcribed, your own voice notes included.\n\nReply *yes* to exclude, *no* to cancel.`)
      : (he ? `🟢 לתמלל את *${label}*?\nהקלטות בצ'אט הזה יקבלו טקסט מתחתיהן.\n\nלענות *yes* כדי לתמלל, *no* כדי לבטל.`
        : `🟢 Transcribe *${label}*?\nRecordings in this chat will get their text under them.\n\nReply *yes* to include it, *no* to cancel.`);
    this.noteCommand(action, `asked to confirm (${chosen.isGroup ? 'a group' : 'a private chat'})`);
    const sent = await this.sendPaced(chatId, { text }, m ? { quoted: m } : {}).catch(() => null);
    this.pendingSwitch = { postId: sent?.key?.id || null, action, options, chosen, at: Date.now() };
  }

  /** An answer to an include/exclude question: a number picks, yes applies, no cancels. */
  async handleSwitchReply(m, n, lower) {
    if (this.ownPosts.has(n.id)) return false;
    const p = this.pendingSwitch;
    if (!p || Date.now() - p.at > PENDING_SWITCH_TTL_MS || (n.quoted && n.quoted.stanzaId !== p.postId)) return false;
    const he = this.ownerLocale() === 'he';
    if (lower === 'no') {
      this.pendingSwitch = null;
      this.noteCommand(p.action, 'cancelled');
      await this.sendPaced(n.chatId, { text: he ? '👌 בוטל. שום דבר לא השתנה.' : '👌 Cancelled. Nothing changed.' }, { quoted: m }).catch(() => {});
      return true;
    }
    if (!p.chosen) {
      const pick = /^\d{1,2}$/.test(lower) ? p.options[Number(lower) - 1] : null;
      if (!pick) return false;
      await this.confirmSwitch(m, n.chatId, p.action, p.options, pick);
      return true;
    }
    if (lower !== 'yes') return false;
    this.pendingSwitch = null;
    await this.applySwitch(p.chosen, p.action);
    return true;
  }

  /** Switch the chat, under every id it may arrive with, and say so in the control group. */
  async applySwitch({ chatId, ids, name, isGroup }, action) {
    // One mode per chat: the three sets never hold the same chat. An included private chat is on even
    // where the settings page has private chats off, or only some people picked.
    const all = new Set([...(ids || []), ...(await this.chatIdsFor(chatId))]);
    const include = action === 'include', quiet = action === 'private';
    for (const id of isGroup ? [chatId] : all) include ? this.enabled.add(id) : this.enabled.delete(id);
    for (const id of all) { action === 'exclude' ? this.muted.add(id) : this.muted.delete(id); quiet ? this.quiet.add(id) : this.quiet.delete(id); }
    this.saveSet('enabled.json', this.enabled); this.saveSet('muted.json', this.muted); this.saveSet('quiet.json', this.quiet);
    console.log(`${this.tag} ${include ? '🟢 included' : quiet ? '🔒 private' : '🔇 excluded'}: a ${isGroup ? 'group' : 'private chat'}`);
    this.noteCommand(action, `done (${isGroup ? 'a group' : 'a private chat'})`);
    const he = this.ownerLocale() === 'he';
    const text = quiet
      ? (he ? `🔒 בוצע: *${name}* מתומלל בפרטיות. הטקסט של כל הקלטה שם יגיע לכאן. כדי שיופיע בצ'אט: *include ${name}*. כדי להפסיק: *exclude ${name}*.`
        : `🔒 Done: *${name}* is transcribed privately. The text of every recording there comes here. To post it in the chat instead: *include ${name}*. To stop: *exclude ${name}*.`)
      : include
      ? (he ? `🟢 בוצע: *${name}* מתומלל. הטקסט יופיע בצ'אט, מתחת לכל הקלטה. כדי להפסיק: *exclude ${name}*.` : `🟢 Done: *${name}* is transcribed. The text appears in the chat, under each recording. To stop: *exclude ${name}*.`)
      : (he ? `🔇 בוצע: *${name}* מוחרג. שום הקלטה בו לא מתומללת. כדי להחזיר: *include ${name}*.` : `🔇 Done: *${name}* is excluded. Nothing in it is transcribed. To bring it back: *include ${name}*.`);
    const sent = await this.sendPaced(this.target.jid, { text }).catch(() => null);
    if (sent?.key?.id) this.recordFwd(sent.key.id, { chatId, name });
  }

  /** "exclude" or "include" alone: what is switched now, and how to switch a chat. */
  switchStatus(action) {
    const he = this.ownerLocale() === 'he';
    const nameOf = (jid) => this.contactNames.get(jid) || this.groupNames.get(jid) || null;
    const names = (ids) => [...new Set([...ids].map(nameOf).filter(Boolean))];
    const excluded = names(this.muted), included = names([...this.enabled].filter((j) => !this.muted.has(j)));
    const privately = names(this.quiet);
    const list = action === 'exclude' ? excluded : action === 'private' ? privately : included;
    const head = action === 'private'
      ? (he ? (list.length ? `🔒 מתומללים בפרטיות: ${list.join(', ')}` : "🔒 אין צ'אטים שמתומללים בפרטיות.") : (list.length ? `🔒 Transcribed privately: ${list.join(', ')}` : '🔒 No chat is transcribed privately.'))
      : action === 'exclude'
      ? (he ? (list.length ? `🔇 מוחרגים: ${list.join(', ')}` : "🔇 אין צ'אטים מוחרגים.") : (list.length ? `🔇 Excluded: ${list.join(', ')}` : '🔇 No chat is excluded.'))
      : (he ? (list.length ? `🟢 קבוצות מתומללות: ${list.join(', ')}` : '🟢 אף קבוצה לא מתומללת.') : (list.length ? `🟢 Groups transcribed: ${list.join(', ')}` : '🟢 No group is transcribed.'));
    return `${head}\n${he ? `כדי לשנות: *${action}* ואת השם, למשל *${action} אמא*.` : `To switch one: *${action}* and the name, e.g. *${action} Mom*.`}`;
  }

  resolveQuotedSource(quotedId, contextInfo) {
    const mapped = this.fwdMap.get(quotedId);
    if (mapped) return mapped;
    const qm = contextInfo?.quotedMessage;
    const qtext = qm?.conversation || qm?.extendedTextMessage?.text || '';
    const mm = qtext.match(/(?:from \*|«)([^*»\n]+)/);
    if (!mm) return null;
    const name = mm[1].trim();
    const hits = [...this.groupNames.entries(), ...this.contactNames.entries()].filter(([, v]) => v === name);
    return hits.length === 1 ? { chatId: hits[0][0], name } : null;
  }

  // ---------- commands ----------
  async handleCommand(m, n, chatName) {
    const txt = (n.body || '').trim();
    if (!txt) return false;
    const lower = txt.toLowerCase();
    const inControl = this.target?.jid && n.chatId === this.target.jid;

    // Manual fallback for arming the control group (only needed if auto-creation failed).
    if (n.isGroup && n.fromMe && lower === TARGET_KEYWORD) {
      // The control group must be the owner's alone: it's where private replies
      // and on/off controls live, and its name is shown on the link page.
      let meta = null;
      try { meta = await this.sock.groupMetadata(n.chatId); } catch { /* unavailable */ }
      const others = (meta?.participants || []).filter((p) => !this.isSelfChat(jidNormalizedUser(p.id)) && p.id !== this.ownId && p.id !== this.ownLid);
      if (!meta || others.length > 0) {
        await this.sendPaced(n.chatId, { text: `This group has other members, so it can't be the ${PRODUCT_NAME} control group. Create a group with only you in it and post the command there.` }).catch(() => {});
        return true;
      }
      this.target = { jid: n.chatId, name: String(chatName || PRODUCT_NAME).slice(0, 80), setAt: Date.now() };
      saveJson(this.f('target.json'), this.target); this.needsManualGroup = false;
      await this.sendPaced(n.chatId, { text: this.welcomeText() }).catch(() => {});
      await this.setGroupIcon();
      return true;
    }
    if (inControl && n.fromMe && !n.hasMedia && lower === 'help' && !this.ownPosts.has(n.id)) {
      this.noteCommand('help', 'shown');
      await this.sendPaced(n.chatId, { text: this.helpText() }, { quoted: m }).catch(() => {});
      return true;
    }
    // language, or language <name>: the transcription language, set from WhatsApp.
    const lang = /^language(?:\s*:?\s*(\S+))?$/.exec(lower);
    if (inControl && n.fromMe && !n.hasMedia && lang && !this.ownPosts.has(n.id)) {
      const before = this.language, text = this.languageReply(lang[1]);
      this.noteCommand('language', !lang[1] ? 'shown' : this.language !== before ? `set to ${this.language || 'auto'}` : 'unchanged (same, or not a language)');
      await this.sendPaced(n.chatId, { text }, { quoted: m }).catch(() => {});
      return true;
    }
    // Three digits: the code a browser shows at the settings page's door. It opens that browser (door.js).
    if (inControl && n.fromMe && !n.hasMedia && /^\d{3}$/.test(txt) && !this.ownPosts.has(n.id)) {
      const device = answerDoor(this, txt);
      if (device != null) {
        this.noteCommand('code', 'browser opened');
        // With the link again: going back to the browser by hand is not obvious, and the link lands there signed in.
        const url = settingsUrl(this.id), he = this.ownerLocale() === 'he';
        const text = he ? `✅ ההגדרות נפתחו ב-${device}.${url ? `\n\nהן מוכנות לך כאן:\n${url}` : ''}` : `✅ Settings opened on ${device}.${url ? `\n\nThey're ready for you here:\n${url}` : ''}`;
        await this.sendPaced(n.chatId, { text }, { quoted: m }).catch(() => {});
        return true;
      }
    }
    // settings: a link to the settings page. A browser not signed in yet asks for a code first.
    if (inControl && n.fromMe && !n.hasMedia && lower === 'settings' && !this.ownPosts.has(n.id)) {
      const url = settingsUrl(this.id), he = this.ownerLocale() === 'he';
      this.noteCommand('settings', url ? 'link sent' : 'no site address set');
      await this.sendPaced(n.chatId, { text: !url
        ? (he ? '⚙️ לשרת הזה לא הוגדרה כתובת אתר (PUBLIC_URL), ולכן אין קישור לדף ההגדרות.' : "⚙️ This server has no site address set (PUBLIC_URL), so there's no link to the settings page.")
        : he ? `⚙️ ההגדרות שלך, מה מתומלל ואיפה הטקסט מופיע: ${url}`
        : `⚙️ Your settings, what gets transcribed and where the text appears: ${url}` }, { quoted: m }).catch(() => {});
      return true;
    }
    // groups, or groups off / groups mine: what happens in groups nobody switched.
    const grp = /^groups(?:\s*:?\s*(\S+))?$/.exec(lower);
    if (inControl && n.fromMe && !n.hasMedia && grp && !this.ownPosts.has(n.id)) {
      const want = ['off', 'mine', 'others', 'all', 'private'].includes(grp[1]) ? grp[1] : null;
      const changed = want && want !== this.groups;
      if (changed) { this.groups = want; this.persistRecord(); console.log(`${this.tag} 👥 groups → ${want}`); }
      this.noteCommand('groups', changed ? `set to ${want}` : want ? `already ${want}` : grp[1] ? 'not an option' : 'shown');
      await this.sendPaced(n.chatId, { text: this.groupsReply(want ? 'set' : 'show') }, { quoted: m }).catch(() => {});
      return true;
    }
    // pause / resume: stop transcribing for a while, and start again.
    if (inControl && n.fromMe && !n.hasMedia && (lower === 'pause' || lower === 'resume') && !this.ownPosts.has(n.id)) {
      const want = lower === 'pause';
      const how = want === this.paused ? (want ? 'already-paused' : 'already-running') : (want ? 'paused' : 'resumed');
      if (want !== this.paused) { this.paused = want; this.persistRecord(); console.log(`${this.tag} ${want ? '⏸️ paused' : '▶️ resumed'} by the owner`); }
      this.noteCommand(lower, how.replace('-', ' '));
      await this.sendPaced(n.chatId, { text: this.pauseReply(how) }, { quoted: m }).catch(() => {});
      return true;
    }
    // leave, then yes: unlink and erase, from inside WhatsApp.
    if (inControl && n.fromMe && !n.hasMedia && await this.handleLeave(m, n, lower)) return true;
    // A dictated message waiting for a recipient, or one to take back.
    if (inControl && n.fromMe && !n.hasMedia && await this.handleDictationReply(m, n, lower)) return true;
    // include / exclude a chat: by name, or as a reply to a forwarded recording's text. Always asks first.
    if (inControl && n.fromMe && !n.hasMedia && !this.ownPosts.has(n.id) && await this.handleSwitchReply(m, n, lower)) return true;
    const sw = /^(include|exclude|private)(?:\s+([\s\S]+))?$/i.exec(txt);
    if (inControl && n.fromMe && !n.hasMedia && sw && !this.ownPosts.has(n.id)) {
      await this.askSwitch(m, n, sw[1].toLowerCase(), (sw[2] || '').trim());
      return true;
    }
    // delete, as a reply to any post of ours: revoke it for everyone, then the command.
    if (n.fromMe && n.quoted && lower === 'delete') {
      const key = { remoteJid: n.chatId, fromMe: true, id: n.quoted.stanzaId, ...(n.isGroup && this.ownId ? { participant: this.ownId } : {}) };
      try { await this.sock.sendMessage(n.chatId, { delete: key }); this.noteCommand('delete', 'done'); } catch (e) { this.noteCommand('delete', 'failed'); console.warn(`${this.tag} delete failed: ${firstLine(e)}`); }
      try { await this.sock.sendMessage(n.chatId, { delete: m.key }); } catch { /* best effort */ }
      return true;
    }
    // names: … in Notes to self.
    if (n.fromMe && this.isSelfChat(n.chatId) && /^names\b/i.test(txt)) {
      const rest = txt.replace(/^names\s*:?\s*/i, '').trim();
      const g = this.glossary; let reply;
      this.noteCommand('names', !rest ? 'shown' : rest.startsWith('-') ? 'removed' : 'added');
      if (!rest) reply = g.list().length ? `📇 Known names (${g.list().length}): ${g.list().join(', ')}` : '📇 No names yet. Write: *names: David, Eden*';
      else if (rest.startsWith('-')) reply = `📇 Removed ${g.remove(rest.slice(1).split(/[,،]/))}. Now: ${g.list().join(', ') || '(none)'}`;
      else reply = `📇 Added ${g.add(rest.split(/[,،]/))}. Known names (${g.list().length}): ${g.list().join(', ')}`;
      await this.sendPaced(n.chatId, { text: reply }, { quoted: m }).catch(() => {});
      return true;
    }
    // Typed in the Ramble group and nothing took it: an answer nothing was waiting for, or not a command.
    if (inControl && n.fromMe && !n.hasMedia && !this.ownPosts.has(n.id)) {
      this.noteCommand(/^(yes|no|undo|\d{1,2})$/.test(lower) ? 'reply' : 'text', /^(yes|no|undo|\d{1,2})$/.test(lower) ? 'nothing was waiting for it (expired or already answered)' : 'not a command');
      this.cmdNow = null; // nothing is sent back for these
    }
    return false;
  }

  noteCommand(cmd, outcome) {
    const e = { at: Date.now(), cmd, outcome, replied: null };
    this.commands = [...this.commands, e].slice(-30); this.cmdNow = e;
    saveJson(this.f('commands.json'), this.commands);
  }

  // ---------- the settings page ----------
  /** A chat's name for the page: the saved or shown name, else its number. */
  chatLabel(jid) {
    const alt = this.altIds.get(jid);
    const name = this.groupNames.get(jid) || (this.savedNames.has(alt) ? this.contactNames.get(alt) : null) || this.contactNames.get(jid) || this.contactNames.get(alt);
    if (name) return String(name).trim();
    const pn = [jid, alt].find((id) => id?.endsWith('@s.whatsapp.net'));
    return pn ? `+${pn.split('@')[0]}` : '…';
  }
  /** The settings page was opened (counted for the admin page). */
  noteSettingsVisit(now = Date.now()) {
    const u = this.settingsUse; u.visits += 1; u.lastAt = now; u.firstAt ||= now;
    this.persistRecord();
  }
  /** Everything the page draws: the settings, with names for the picked chats, and whether transcription is on at all. */
  settingsView() {
    const section = (k) => ({ ...this.settings[k], some: this.settings[k].some.map((id) => ({ id, name: this.chatLabel(id) })) });
    return { where: whereOf(this.settings), chats: section('chats'), groups: section('groups'), language: this.language || '', paused: this.paused, firstNoteAt: this.firstNoteAt || null, groupLink: this.target?.invite ? `https://chat.whatsapp.com/${this.target.invite}` : null };
  }
  /**
   * A change from the page, saved at once. "Only to me" means nothing is posted in any chat, so the
   * chats included from WhatsApp (text in the chat) move to private mode (text only here) with it.
   */
  async updateSettings(patch) {
    const before = this.settings;
    this.settings = applyPatch(before, patch);
    if (typeof patch?.language === 'string' && LANGUAGES.some(([code]) => code === patch.language) && patch.language !== this.language) this.setLanguage(patch.language);
    const toMe = (k) => this.settings[k].where === 'me' && before[k].where !== 'me';
    if (toMe('chats') || toMe('groups')) {
      let moved = 0;
      for (const id of [...this.enabled]) {
        if (!toMe(id.endsWith('@g.us') ? 'groups' : 'chats')) continue;
        for (const each of await this.chatIdsFor(id)) { this.enabled.delete(each); this.quiet.add(each); }
        moved++;
      }
      if (moved) { this.saveSet('enabled.json', this.enabled); this.saveSet('quiet.json', this.quiet); console.log(`${this.tag} 🔒 ${moved} included chat(s) moved to private mode with "only to me"`); }
    }
    const u = this.settingsUse; u.changes += 1; u.lastChangeAt = Date.now();
    this.persistRecord();
    const d = (k) => { const x = this.settings[k]; return `${x.on ? `${x.who}/${x.where}${x.some.length ? `/${x.some.length} picked` : ''}` : 'off'}`; };
    console.log(`${this.tag} ⚙️ settings → chats ${d('chats')} · groups ${d('groups')}`);
    return this.settingsView();
  }
  /**
   * The chats the page lets the owner pick from, the most recently active first: groups as [id, name,
   * members, lastActive, quiet], people as [id, name, saved, lastActive, quiet], one row per person (phone
   * id over lid). Quiet = archived or muted: the page leaves those out until a search.
   */
  async settingsDirectory(kind) {
    if (kind === 'groups') {
      await this.switchDirectory();
      // A community's own entry is not a group: WhatsApp moves it up for activity in any group inside it.
      return [...this.groupNames].filter(([jid, name]) => name && jid !== this.target?.jid && !this.communities.has(jid))
        .map(([jid, name]) => [jid, String(name).trim(), this.groupSizes.get(jid) || 0, this.activityOf(jid).at, this.archived.has(jid) || this.isMuted(jid) ? 1 : 0])
        .sort((a, b) => b[3] - a[3] || a[1].localeCompare(b[1]));
    }
    await this.learnLidPhones();
    const rows = new Map();
    for (const [jid, name] of this.contactNames) {
      if (!name || this.isSelfChat(jid) || jid.endsWith('@g.us') || !/@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
      const alt = this.altIds.get(jid), id = jid.endsWith('@lid') && alt ? alt : jid;
      if (rows.has(id)) continue;
      const quiet = this.archived.has(jid) || (alt && this.archived.has(alt)) || this.isMuted(id) ? 1 : 0;
      rows.set(id, [id, this.chatLabel(id), this.savedNames.has(jid) || this.savedNames.has(alt) ? 1 : 0, this.activityOf(id).at, quiet, (this.activity.get(jid) || 0) + (this.activity.get(alt) || 0)]);
    }
    return [...rows.values()].sort((a, b) => b[3] - a[3] || b[5] - a[5] || b[2] - a[2] || a[1].localeCompare(b[1])).slice(0, 2000).map((r) => r.slice(0, 5));
  }
  /**
   * Feedback or a problem, written on the settings page: kept with the account (so leaving erases it)
   * for the operator to read on the admin page. At most ten a day; the log says only that one came.
   */
  addFeedback(text) {
    const body = String(text || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    if (!body) return 'empty';
    const day = Date.now() - 86400e3;
    if (this.feedback.filter((f) => f.at > day).length >= 10) return 'too many';
    this.feedback = [...this.feedback, { at: Date.now(), text: body }].slice(-50);
    saveJson(this.f('feedback.json'), this.feedback);
    console.log(`${this.tag} 💬 feedback received (${body.length} chars)`);
    return 'ok';
  }
  /**
   * WhatsApp may send a person's messages under a lid, which hides the number, while the owner saved them
   * under their number. The linked device knows which number a lid stands for: learn those pairs, so that one
   * person is one row, under the name the owner saved, with the activity from both ids.
   */
  async learnLidPhones() {
    const map = this.sock?.signalRepository?.lidMapping;
    if (!map?.getPNForLID) return;
    this._lidUnknown ??= new Set(); // asked once and not known: not asked again until the account restarts
    const lids = [...new Set([...this.contactNames.keys(), ...this.chatActivity.keys()])].filter((j) => j.endsWith('@lid') && !this.altIds.has(j) && !this._lidUnknown.has(j)).slice(0, 3000);
    let learned = false;
    await Promise.all(lids.map(async (lid) => {
      try { const pn = await map.getPNForLID(lid); if (pn) learned = this.learnAltIds(jidNormalizedUser(pn), lid, { save: false }) || learned; else this._lidUnknown.add(lid); } catch { this._lidUnknown.add(lid); }
    }));
    if (learned) this.saveMap('altids.json', this.altIds, 6000);
  }
  /** A number typed into the page's search: the private chat it belongs to, if WhatsApp knows one. */
  async settingsNumber(q) {
    const [o] = await this.switchByNumber(String(q || '').slice(0, 40));
    if (!o) return null;
    const id = o.ids.find((x) => x.endsWith('@s.whatsapp.net')) || o.chatId;
    return [id, this.chatLabel(id), 0];
  }

  // ---------- sending (paced, one queue per account) ----------
  sendPaced(jid, content, opts = {}) {
    const cmd = this.cmdNow; this.cmdNow = null; // the reply to the command just noted, if any
    const replied = (ok) => { if (cmd) { cmd.replied = ok; saveJson(this.f('commands.json'), this.commands); } };
    const run = async () => {
      if (this.stopped) throw new Error('account stopped');
      // A burst of messages from one number reads as a bot to WhatsApp, so a message that follows
      // another from this account within a few seconds waits 1–3 s. A lone message goes at once.
      if (Date.now() - this.lastSentAt < SEND_PACE_WINDOW_MS) {
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
        if (this.stopped) throw new Error('account stopped'); // checked again after the wait
      }
      if (!this.sock) throw new Error('not connected');
      const sent = await this.sock.sendMessage(jid, content, opts);
      this.lastSentAt = Date.now();
      if (sent?.key?.id) { this.ownPosts.add(sent.key.id); if (this.ownPosts.size > 500) this.ownPosts.delete(this.ownPosts.values().next().value); }
      if (jid === this.target?.jid && !content.delete && !content.react && !content.edit) this.markControlUnread(sent);
      return sent;
    };
    const p = this.sendChain.then(run, run);
    p.then(() => replied(true), () => replied(false));
    this.sendChain = p.catch(() => {});
    return p;
  }

  // ---------- status (no message content, ever) ----------
  status({ full = false, history = false } = {}) {
    const base = {
      id: this.id, label: this.label, language: this.language || 'auto', createdAt: this.createdAt, linkedAt: this.linkedAt || null,
      plan: this.plan, model: planLabel(this.plan), abModel: this.abModel || null, keepAudio: this.keepAudio, transcribeVideo: this.transcribeVideo, voiceFix: this.voiceFix, paused: this.paused,
      mode: this.mode, ready: this.ready, controlGroup: this.target?.name || null, needsManualGroup: this.needsManualGroup,
      enabledGroups: this.enabled.size, mutedChats: this.muted.size, privateChats: this.quiet.size, groups: this.groups, capMinutes: this.capMinutes || null, minutesToday: Math.round(this.usageSecondsToday() / 60),
      lastMessageAt: this.lastMessageAt || null, stats: this.stats, lastError: this.lastError,
      inviteCode: this.inviteCode, invited: this.invited, dailyMinutes: this.dailyCapMinutes(), bonusMinutes: this.bonusMinutes,
    };
    // The admin page also sees who the account is: its number, WhatsApp name and who invited it.
    // The settings as the admin page sees them: no chat ids, only how many were picked.
    const section = (k) => { const x = this.settings[k]; return { on: x.on, who: x.who, where: x.where, picked: x.some.length }; };
    if (history) Object.assign(base, { settings: { chats: section('chats'), groups: section('groups') }, settingsUse: this.settingsUse, usageHistory: this.usageHistory, totals: this.totals, commands: this.commands.slice(-12).reverse(), phone: this.phone || null, waName: this.waName || null, referredBy: this.referredBy || null });
    return full ? { ...base, qr: this.qr, pairingCode: this.pairingCode, pairByCode: !!this.pairPhone, rescan: this.pairRefreshedAt > 0 && Date.now() - this.pairRefreshedAt < 180e3, waMe: this.ownId ? `https://wa.me/${this.ownId.split('@')[0]}` : null, product: PRODUCT_NAME } : base;
  }
}
