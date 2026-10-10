/**
 * The plain brain: one transcription at the plan's host, delivered as it came. No
 * correction, no summary, no second reading, no experiment. It is what this repository
 * runs on its own, and the smallest thing that satisfies contract.js — read it to see
 * exactly what leaves the process and what comes back.
 *
 *   TRANSCRIBE_MODEL / FREE_TRANSCRIBE_MODEL   the model at the pro / free host (default whisper-large-v3)
 *   TRANSCRIBE_LANGUAGE                        a language forced on every recording ('' = the account's)
 */
const PLANS = ['free', 'pro'];

export function createBrain({ net, env = {} }) {
  const models = {
    pro: env.TRANSCRIBE_MODEL || env.WHISPER_MODEL || 'whisper-large-v3',
    free: env.FREE_TRANSCRIBE_MODEL || env.SHADOW_TRANSCRIBE_MODEL || 'whisper-large-v3',
  };
  const planEnabled = (plan) => Boolean(net.hosts[plan]?.enabled);
  const planLabel = (plan) => (planEnabled(plan) ? models[plan] : 'not configured');
  const prices = {
    'whisper-large-v3': { minute: 0.111 / 60 }, 'whisper-large-v3-turbo': { minute: 0.04 / 60 }, 'whisper-1': { minute: 0.006 },
    'gpt-4o-transcribe': { minute: 0.006 }, 'gpt-4o-mini-transcribe': { minute: 0.003 },
  };

  function info() {
    return {
      enabled: PLANS.some(planEnabled), plans: PLANS, planEnabled, planLabel,
      correction: null, summary: null, dictation: false, experiment: null, prices,
      startupLines: () => [`🎙️  Transcription per plan: pro → ${planLabel('pro')}${planEnabled('free') ? `, free → ${planLabel('free')}` : ''} · plain brain: no correction, no summary`],
    };
  }

  async function process({ audio, plan = 'pro', language = '', signal, onStage }) {
    const host = planEnabled(plan) ? plan : PLANS.find(planEnabled);
    if (!host) throw new Error('no transcription host configured');
    const lang = env.TRANSCRIBE_LANGUAGE || language || '';
    const text = await net.transcribeAudio(host, audio, { model: models[host], language: lang, signal });
    onStage?.('transcribed');
    const dropped = text ? null : 'empty';
    onStage?.('corrected');
    return {
      text: dropped ? null : text, summary: null, raw: text || null, dropped,
      model: models[host], language: lang, retry: null, usedFallback: host !== plan,
      fix: { text: null, reason: 'skipped' }, alts: [], arm: 'A', armReason: null, conf: null,
      compare: [], later: null, report: null,
    };
  }

  // The plain brain reads no instructions out of a recording.
  async function dictation() { return null; }

  // Nor does it correct a transcript from a spoken reply.
  async function amend() { return null; }

  return { info, process, dictation, amend };
}
