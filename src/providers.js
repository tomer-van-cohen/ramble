/**
 * The only door out of this process to a model provider.
 *
 * Every byte of audio and every line of text that leaves Ramble for a model goes through
 * the two functions here — transcribeAudio() and chatCompletion() — to one of the hosts
 * listed in HOSTS. Nothing else in the code calls a provider, and a host that is not in
 * the list cannot be called: the caller names a host, it does not hand over a URL.
 *
 * What a call carries is exactly what the function takes: the audio (or the text), the
 * model name, a language code, an optional prompt. Nothing about the account, the chat
 * or the sender travels unless the caller put it in the prompt text itself.
 *
 * Hosts, from the environment (keys and addresses only — which model runs where is the
 * caller's business):
 *   pro           TRANSCRIBE_API_KEY / TRANSCRIBE_BASE_URL          (default Groq)
 *   free          FREE_TRANSCRIBE_API_KEY / FREE_TRANSCRIBE_BASE_URL (default Groq; SHADOW_* still read)
 *   groq          GROQ_API_KEY (or the free host when it is Groq)   https://api.groq.com/openai/v1
 *   deepinfra     DEEPINFRA_API_KEY / DEEPINFRA_BASE_URL
 *   chat          SUMMARY_API_KEY / SUMMARY_BASE_URL                (default OpenAI; key falls back to
 *                 the transcription key of the same host)
 *   chatFallback  LLM_FALLBACK_API_KEY / LLM_FALLBACK_BASE_URL      (default: Groq when chat is not Groq
 *                 and a Groq key is around; nothing otherwise)
 *
 * Errors: an HTTP error carries `status` and `retryAfter` (seconds, from the header); the
 * provider's body is never logged or rethrown — it may echo the request.
 */
import { chargeSpeech, chargeChat } from './cost.js';
import { retryNet, netWhy } from './net.js';

const GROQ_URL = 'https://api.groq.com/openai/v1';
const OPENAI_URL = 'https://api.openai.com/v1';
const DEEPINFRA_URL = 'https://api.deepinfra.com/v1/openai';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const env = (k) => process.env[k] || '';

const PRO = { name: 'pro', apiKey: env('TRANSCRIBE_API_KEY') || env('GROQ_API_KEY') || env('LLM_API_KEY'), baseUrl: env('TRANSCRIBE_BASE_URL') || env('WHISPER_BASE_URL') || GROQ_URL };
const FREE = { name: 'free', apiKey: env('FREE_TRANSCRIBE_API_KEY') || env('SHADOW_TRANSCRIBE_API_KEY'), baseUrl: env('FREE_TRANSCRIBE_BASE_URL') || env('SHADOW_TRANSCRIBE_BASE_URL') || GROQ_URL };
// Whisper models are served by Groq; when the free host is Groq that is the Groq host.
const GROQ = /groq\.com/.test(FREE.baseUrl) ? { ...FREE, name: 'groq' } : { name: 'groq', apiKey: env('GROQ_API_KEY') || env('SHADOW_TRANSCRIBE_API_KEY'), baseUrl: GROQ_URL };
const DEEPINFRA = { name: 'deepinfra', apiKey: env('DEEPINFRA_API_KEY'), baseUrl: env('DEEPINFRA_BASE_URL') || DEEPINFRA_URL };

// SUMMARY_API_KEY overrides only for the MAIN chat host; the fallback must never
// inherit it (an OpenAI key sent to Groq is just a 401).
function chatKeyFor(baseUrl, { allowOverride = true } = {}) {
  if (allowOverride && env('SUMMARY_API_KEY')) return env('SUMMARY_API_KEY');
  const want = hostOf(baseUrl);
  if (hostOf(PRO.baseUrl) === want) return PRO.apiKey;
  if (hostOf(env('SHADOW_TRANSCRIBE_BASE_URL') || OPENAI_URL) === want) return env('SHADOW_TRANSCRIBE_API_KEY');
  return env('SHADOW_TRANSCRIBE_API_KEY') || PRO.apiKey;
}
const CHAT_URL = env('SUMMARY_BASE_URL') || OPENAI_URL;
const CHAT = { name: 'chat', apiKey: chatKeyFor(CHAT_URL), baseUrl: CHAT_URL };
const FB_URL = env('LLM_FALLBACK_BASE_URL') || (hostOf(CHAT_URL) !== hostOf(GROQ_URL) && chatKeyFor(GROQ_URL, { allowOverride: false }) ? GROQ_URL : '');
const CHAT_FALLBACK = FB_URL ? { name: 'chatFallback', apiKey: env('LLM_FALLBACK_API_KEY') || chatKeyFor(FB_URL, { allowOverride: false }), baseUrl: FB_URL } : null;

/** The closed list. Each entry: { name, apiKey, baseUrl }; a host without a key is listed but off. */
export const HOSTS = Object.freeze({ pro: PRO, free: FREE, groq: GROQ, deepinfra: DEEPINFRA, chat: CHAT, chatFallback: CHAT_FALLBACK });
export const hostEnabled = (host) => Boolean(resolve(host)?.apiKey);
export const hostLabel = (host) => hostOf(resolve(host)?.baseUrl || '');
export const isGroq = (host) => /groq\.com/.test(resolve(host)?.baseUrl || '');
export const isOpenAI = (host) => /api\.openai\.com/.test(resolve(host)?.baseUrl || '');

// A host is named, or given as an object that carries the name of a listed host. Its own
// baseUrl/apiKey fields are not trusted: the listed ones are used.
function resolve(host) {
  const name = typeof host === 'string' ? host : host?.name;
  const h = HOSTS[name];
  if (!h) throw new Error(`unknown provider host "${name}"`);
  return h;
}

const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS ?? 60_000);
const AUDIO_MIME = { ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', amr: 'audio/amr', aac: 'audio/aac' };

function combineSignals(signal, timeoutMs) {
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(new Error('timeout')), timeoutMs);
  const signals = [own.signal, ...(signal ? [signal] : [])];
  const combined = signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : own.signal;
  return { signal: combined, done: () => clearTimeout(timer) };
}

/**
 * Speech to text: POST /audio/transcriptions at `host`.
 * @param {string|{name:string}} host   one of HOSTS
 * @param {{buf:Buffer, name?:string}} audio   the recording; `name` only sets the MIME type
 * @param {{model:string, language?:string, prompt?:string, signal?:AbortSignal, details?:boolean, timeoutMs?:number}} o
 * @returns {Promise<string|{text:string, language:string, segments:object[]}>}
 *          the text; with `details`, the text plus what the provider says about it (verbose_json)
 */
export async function transcribeAudio(host, audio, { model, language = '', prompt = '', signal, details = false, timeoutMs = TRANSCRIBE_TIMEOUT_MS } = {}) {
  const h = resolve(host);
  if (!h.apiKey) throw new Error(`no key for the ${h.name} host`);
  if (!model) throw new Error('transcribeAudio: model is required');
  const name = String(audio?.name || 'audio.ogg');
  const ext = name.split('.').pop().toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([audio.buf], { type: AUDIO_MIME[ext] || 'audio/mpeg' }), name);
  form.append('model', model);
  form.append('response_format', details ? 'verbose_json' : 'text');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  const { signal: sig, done } = combineSignals(signal, timeoutMs);
  try {
    // A connection that drops before any answer gets one more try; an answer, even an error, does not.
    const res = await retryNet(() => fetch(`${h.baseUrl}/audio/transcriptions`, {
      method: 'POST', signal: sig,
      headers: { Authorization: `Bearer ${h.apiKey}` },
      body: form,
    }), { label: model, signal: sig });
    if (!res.ok) {
      // Status plus a machine code is all anyone needs; the body may echo the request.
      const body = await res.text().catch(() => '');
      let code = ''; try { const j = JSON.parse(body); code = j?.error?.code || j?.error?.type || ''; } catch { /* not json */ }
      const err = new Error(`${model} HTTP ${res.status}${code ? ` (${String(code).slice(0, 40)})` : ''}`);
      err.status = res.status; err.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    chargeSpeech(model);
    if (!details) return (await res.text()).trim();
    const j = await res.json();
    return { text: String(j.text || '').trim(), language: String(j.language || ''), segments: Array.isArray(j.segments) ? j.segments : [] };
  } finally {
    done();
  }
}

/**
 * Chat completion: POST /chat/completions at `host`. Fails closed: any error, timeout
 * or cut-off reply is null (logged with the status code only).
 * @param {string|{name:string}} host   one of HOSTS
 * @param {{system:string, user:string, model:string, maxTokens?:number, temperature?:number, timeoutMs?:number}} o
 * @returns {Promise<string|null>}
 */
export async function chatCompletion(host, { system, user, model, maxTokens = 600, temperature = 0, timeoutMs = 8000 }) {
  const h = resolve(host);
  if (!h.apiKey) return null;
  if (!model) throw new Error('chatCompletion: model is required');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${h.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.apiKey}` },
      // OpenAI's gpt-5 and later / o-series chat models take max_completion_tokens, reject a
      // custom temperature, and want a small reasoning budget for a short job.
      body: JSON.stringify(/^(gpt-([5-9]|\d{2,})|o[1-9])/.test(model) ? {
        model, max_completion_tokens: maxTokens, reasoning_effort: 'low',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      } : {
        model, temperature, max_tokens: maxTokens,
        ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        ...(model.includes('qwen') ? { reasoning_effort: 'none' } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let code = ''; try { code = JSON.parse(body)?.error?.code || JSON.parse(body)?.error?.type || ''; } catch { /* not json */ }
      console.warn(`   ⚠️  llm ${model} → HTTP ${res.status}${code ? ` (${code})` : ''}`); return null;
    }
    const json = await res.json();
    chargeChat(model, json.usage); // billed even when the reply is then refused by the caller
    const choice = json.choices?.[0];
    if (!choice || choice.finish_reason === 'length') { console.warn(`   ⚠️  llm ${model} → ${!choice ? 'no choice' : 'truncated (finish_reason=length)'}`); return null; } // never trust a cut-off reply
    return choice.message?.content?.trim() || null;
  } catch (e) {
    console.warn(`   ⚠️  llm ${model} → ${e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : netWhy(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
