/**
 * The contract between the shell (this repository) and the brain: the part of Ramble that
 * turns a recording into good text.
 *
 * The shell owns everything that touches data: where a recording lands and when it is
 * deleted, what is kept only on opt-in, what the log may say, and the closed list of
 * hosts data can go to (providers.js). The brain is a function over what the shell hands
 * it: it gets the audio as a buffer and the two network functions, and returns text. It
 * is given no path, no account id, no file system, no URL.
 *
 * Two brains satisfy this contract: `plain.js` here (one transcription, nothing else),
 * and a private one loaded from `brain/` when it is checked out beside `src/`.
 *
 * @typedef {object} Deps                what the loader hands to createBrain()
 * @property {object} net
 * @property {Function} net.transcribeAudio   providers.transcribeAudio(host, audio, opts)
 * @property {Function} net.chatCompletion    providers.chatCompletion(host, opts)
 * @property {Record<string, {enabled:boolean, label:string, groq:boolean, openai:boolean}>} net.hosts
 *                                       the listed hosts, by name, and whether each has a key
 * @property {object} env                process.env (the brain reads its own settings from it)
 *
 * @typedef {object} Recording           what process() takes
 * @property {{buf:Buffer, name:string}} audio   the recording (a video's audio track, extracted by the shell)
 * @property {number} seconds            true length, measured by the shell
 * @property {boolean} isVideo
 * @property {'free'|'pro'} plan
 * @property {string} language           the account's pinned language, '' = auto
 * @property {string|null} speaker       display name of who spoke, for the text jobs
 * @property {boolean} isMe
 * @property {string} names              known names/terms, comma-separated ('' = none)
 * @property {string} fingerprint        the media's hash (or the message id): a stable draw for experiments
 * @property {string|null} compareModels an admin's A/B list for this account, or null
 * @property {boolean} shadow            this account keeps audio: other pipelines may run after delivery
 * @property {AbortSignal} [signal]
 * @property {(stage: 'transcribed'|'corrected') => void} [onStage]   timing marks for the shell's log
 *
 * @typedef {object} Outcome             what process() resolves to (it throws when no text could be had)
 * @property {string|null} text          what to deliver; null when the gate dropped the recording
 * @property {string|null} summary       a headline for a long recording, or null
 * @property {string|null} raw           the transcript before correction
 * @property {string|null} dropped       why the gate dropped it (then text is null)
 * @property {string} model              the model that answered
 * @property {string} language           the language asked for ('' = auto)
 * @property {string|null} retry         which retry answered, if one did
 * @property {boolean} usedFallback      the plan's host failed and another answered
 * @property {{text:string|null, reason:string}} fix   the correction: 'ok', 'skipped', 'unavailable' or why it was refused
 * @property {string[]} alts             other readings handed to the correction
 * @property {string} arm                experiment arm that answered ('A' when none)
 * @property {string|null} armReason     why an arm fell back, if it did
 * @property {object|null} conf          the provider's own confidence numbers, if any
 * @property {Array<{model:string, arm?:string, text:string|null, fixed:string|null, ok?:boolean, reason?:string|null}>} compare
 *                                       other pipelines' texts, when some ran before delivery
 * @property {(() => Promise<{compare:Array, report:string|null}>)|null} later
 *                                       pipelines that run after delivery, so nobody waits for them: the shell
 *                                       calls it once the text is out; resolves with their texts and a report
 *                                       the shell may post in the owner's group
 * @property {string|null} report        a report to post in the owner's group now, if any
 *
 * @typedef {object} Info                info(): what the shell shows and logs
 * @property {boolean} enabled           a transcription host is configured
 * @property {string[]} plans
 * @property {(plan:string)=>boolean} planEnabled
 * @property {(plan:string)=>string} planLabel
 * @property {string|null} correction    label of the correction pass, null when off
 * @property {string|null} summary
 * @property {boolean} dictation
 * @property {null|{shares:{B:number,C:number}, maxSeconds:number, shadow:boolean, reportAccounts:Set<string>, arms:string[], armLabel:(arm:string)=>string}} experiment
 * @property {Record<string, object>} prices   $ per minute of audio / per million tokens, by model (cost.js)
 * @property {() => string[]} startupLines     what app.js prints at start
 *
 * @typedef {object} Brain
 * @property {() => Info} info
 * @property {(rec: Recording) => Promise<Outcome>} process
 * @property {(text: string, ctx?: {trace?: Function}) => Promise<{to:string, spellings:string[], text:string}|null>} dictation
 *                                       a voice note recorded in the owner's group: a message to send, if it is one
 * @property {(original: string, reply: string, ctx?: {raw?: string|null, trace?: Function}) => Promise<{text:string}|null>} [amend]
 *                                       optional: a spoken reply to a posted transcript, from its speaker — the
 *                                       transcript corrected by it, or null when the reply is not a correction;
 *                                       raw is the recogniser's text before the correction pass, when there was one
 */

const METHODS = ['info', 'process', 'dictation'];
const INFO = ['enabled', 'plans', 'planEnabled', 'planLabel', 'correction', 'summary', 'dictation', 'experiment', 'prices', 'startupLines'];

/** Refuses a brain that does not have the surface above. Returns it otherwise. */
export function checkBrain(brain, source = 'brain') {
  for (const m of METHODS) if (typeof brain?.[m] !== 'function') throw new Error(`${source}: missing ${m}()`);
  const info = brain.info();
  for (const k of INFO) if (!(k in info)) throw new Error(`${source}: info() lacks "${k}"`);
  if (!Array.isArray(info.plans) || !info.plans.length) throw new Error(`${source}: info().plans is empty`);
  return brain;
}
