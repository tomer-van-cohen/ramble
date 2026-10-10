/**
 * Which brain runs: the private one checked out at `brain/` beside `src/` (or at
 * BRAIN_DIR), else the plain one here. Both get the same two network functions and the
 * list of hosts; neither gets a path into this process's data.
 *
 *   BRAIN_DIR        where the private brain is (default <repo>/brain)
 *   BRAIN=plain      run the plain brain even when a private one is there (the shell's tests)
 *   REQUIRE_BRAIN=1  refuse to start on the plain brain (production: never ship it by accident)
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOSTS, hostEnabled, hostLabel, isGroq, isOpenAI, transcribeAudio, chatCompletion } from '../providers.js';
import { setPrices } from '../cost.js';
import { checkBrain } from './contract.js';
import { createBrain as createPlain } from './plain.js';

const here = dirname(fileURLToPath(import.meta.url));
const privateDir = process.env.BRAIN_DIR ? resolve(process.env.BRAIN_DIR) : join(here, '..', '..', 'brain');
const privateEntry = join(privateDir, 'index.js');

const hosts = Object.fromEntries(Object.keys(HOSTS).filter((k) => HOSTS[k]).map((k) => [k, { enabled: hostEnabled(k), label: hostLabel(k), groq: isGroq(k), openai: isOpenAI(k) }]));
const deps = { net: { transcribeAudio, chatCompletion, hosts }, env: process.env };

/** 'private' or 'plain'. */
export let brainSource = 'plain';
let create = createPlain;
if (process.env.BRAIN === 'plain' && process.env.REQUIRE_BRAIN !== '1') {
  // the plain one, on purpose
} else if (existsSync(privateEntry)) {
  const mod = await import(pathToFileURL(privateEntry).href);
  if (typeof mod.createBrain !== 'function') throw new Error(`${privateEntry} does not export createBrain()`);
  create = mod.createBrain; brainSource = 'private';
} else if (process.env.REQUIRE_BRAIN === '1') {
  throw new Error(`REQUIRE_BRAIN=1 but no brain at ${privateEntry}`);
}

export const brain = checkBrain(create(deps), brainSource);
setPrices(brain.info().prices || {});
