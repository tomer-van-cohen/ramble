# Working on Ramble

## ⛔ Never deploy without asking Tomer first

Every deploy restarts the server: every linked account drops and reconnects, and
recordings that arrive meanwhile wait or are lost. That is downtime for real users.
So **no `railway up` (or any other deploy) after a change, ever, unless Tomer said
yes to that deploy in the conversation.** Deploys happen at night, when he asks for
one. Commit and push as usual; then say what is waiting to go out and stop there.

When he says yes, deploy with `scripts/deploy.sh`, not a bare `railway up`: it closes
sign-ups first and waits until no one is halfway through linking (a link cut off
before its first sync is one WhatsApp drops), then uploads.


Read [CONTRIBUTING.md](CONTRIBUTING.md) first; its ground rules bind agents too.

## The brain is private; this repository is the shell

Everything that turns a recording into good text — model strategy, retries, hints, the
sanity gate, the correction/summary/dictation prompts, the experiment's arms and judging —
is Tomer's IP. It lives in the private repository `tomer-van-cohen/ramble-brain`, checked
out at `brain/` (gitignored here) and loaded at start through `src/brain/index.js`; this
repository runs on its own with the plain brain in `src/brain/plain.js`.

- Nothing of that kind goes into `src/`, `test/`, docs or commit messages here. The hook
  refuses `brain/` paths and any line with the `RAMBLE-PRIVATE` marker; CI checks again.
- Work on the brain happens in `brain/` and is committed and pushed **there** (its own
  `git`, same hooks, same `.private-terms`). The shell's `git status` never shows it.
- The contract is `src/brain/contract.js`. The brain gets a Buffer and the two network
  functions from `src/providers.js`, never a path, an account id or a URL. Keep it so.
- Commit messages in this repository say what changed for the user, not how the brain
  does it. Method goes in the brain's commits.
- Deploys: `scripts/deploy.sh` uploads both (`railway up --no-gitignore`, `.railwayignore`
  keeps secrets and data out) and refuses without a clean, pushed brain and green suites.
  The Docker build fails without `brain/index.js`; `REQUIRE_BRAIN=1` in the image.

## Real data never enters the repository

This is a public repository for a service that sees people's WhatsApp. Production
logs (an opted-in account's 🔬 trace carries transcripts, contact names and ids),
`DATA_DIR`, `/admin/research/...` and the owner's own chats are for *diagnosing*
only. Nothing read there may be copied into source, comments, tests, docs, commit
messages or PR text: no contact or chat names, numbers, jids/lids, message or
transcript text, account ids, hostnames.

When a production failure becomes a regression test, rebuild it from invented
data with the same *shape* (same tiers, scripts, emoji, word order), and
describe the failure in general terms ("a name that is only the last word of a
contact outranked an exact match"), not with what was actually said or to whom.
Never name a fixture `real`.

## Commits

- Author is Tomer Cohen <tomer.van.cohen@gmail.com>; never a work identity.
- `git config core.hooksPath .githooks` is expected to be set: the hooks refuse
  staged lines, messages and author identities that match the local
  `.private-terms` file. If a hook stops you, fix the content; don't bypass it.
