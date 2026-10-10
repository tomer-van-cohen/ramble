#!/bin/zsh
# Deploy without catching anyone halfway through linking their WhatsApp.
#
#   scripts/deploy.sh            close sign-ups, wait until no one is in the middle, then `railway up`
#
# 1. POST /admin/drain?on=1: new sign-ups get the queue page, which waits and carries on by itself.
# 2. Wait until no link page is showing a QR or pairing code and no account linked in the last
#    five minutes (a link whose first sync is cut short is one WhatsApp drops) — at most MAX_WAIT seconds.
# 3. `railway up --no-gitignore`: the working tree including the private brain at ./brain
#    (gitignored here; .railwayignore keeps secrets, data and git out). The new process starts
#    with the door open again (and keeps new sign-ups waiting while the existing accounts
#    reconnect). If the upload fails, the door is opened here.
#
# Before any of that: both checkouts must be clean and pushed, the brain must be there, and
# both suites must pass — a deploy is downtime for every account, so nothing half-done ships.
# The admin credentials are read from the service's Railway variables and never printed.
set -u
SITE=${SITE:-https://ramble.baby}
MAX_WAIT=${MAX_WAIT:-300}
cd "$(dirname "$0")/.."

# `railway up` uploads the working tree, not the last commit: in a checkout several sessions share,
# someone's half-done edit would go out with it. Only a clean tree is deployed (FORCE=1 overrides).
dirty=$(git status --porcelain --untracked-files=no)
if [ -n "$dirty" ] && [ "${FORCE:-0}" != 1 ]; then
  echo "❌ uncommitted changes would be deployed with this — commit or stash them first (FORCE=1 to override):"; echo "$dirty"; exit 1
fi
# The brain: present, its own checkout clean, and pushed (a deploy from a brain nobody can
# reproduce from the private repository is a deploy nobody can roll back to).
if [ ! -f brain/index.js ]; then
  echo "❌ no brain at ./brain — check out tomer-van-cohen/ramble-brain there first"; exit 1
fi
if [ -d brain/.git ]; then
  bdirty=$(git -C brain status --porcelain)
  if [ -n "$bdirty" ] && [ "${FORCE:-0}" != 1 ]; then
    echo "❌ uncommitted changes in the brain would be deployed — commit them first (FORCE=1 to override):"; echo "$bdirty"; exit 1
  fi
  if [ -n "$(git -C brain log --oneline '@{u}..' 2>/dev/null)" ] && [ "${FORCE:-0}" != 1 ]; then
    echo "❌ the brain has commits that are not pushed — push them first (FORCE=1 to override)"; exit 1
  fi
fi
# Both suites, before anything is uploaded (SKIP_TESTS=1 skips them).
if [ "${SKIP_TESTS:-0}" != 1 ]; then
  echo "🧪 shell tests…"; npm test --silent >/dev/null 2>&1 || { echo "❌ the shell's tests fail — not deploying"; exit 1; }
  echo "🧪 brain tests…"; (cd brain && npm test --silent >/dev/null 2>&1) || { echo "❌ the brain's tests fail — not deploying"; exit 1; }
fi

creds=$(railway variables --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);const p=v.ADMIN_PASSWORD||v.DASHBOARD_PASSWORD||'';if(p)process.stdout.write((v.ADMIN_USER||'admin')+':'+p)}catch{}})")
admin() { # method path → body; credentials go through a curl config on stdin, not the command line
  printf 'user = "%s"\n' "$creds" | curl -sS -m 15 -K - -X "$1" -H "Origin: $SITE" "$SITE$2"
}
open_again() { [ -n "$creds" ] && admin POST '/admin/drain?on=0' >/dev/null 2>&1; }

if [ -z "$creds" ]; then
  echo "⚠️  no admin password in the Railway variables — deploying without closing sign-ups first"
else
  first=$(admin POST '/admin/drain?on=1')
  if ! echo "$first" | grep -q '"draining":true'; then
    echo "⚠️  the running server has no drain endpoint (or refused) — deploying without it"
  else
    trap 'open_again; echo; echo "interrupted — sign-ups open again"; exit 130' INT TERM
    echo "🚪 sign-ups closed; waiting for anyone halfway through linking (at most ${MAX_WAIT}s)…"
    waited=0
    while :; do
      st=$(admin GET /admin/drain)
      echo "$st" | grep -q '"ready":true' && { echo "✅ no one in the middle after ${waited}s"; break; }
      [ $waited -ge $MAX_WAIT ] && { echo "⏱️  still $(echo "$st" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));`${j.viewing} on a link page, ${j.justLinked} just linked`') after ${MAX_WAIT}s — deploying anyway"; break; }
      echo "   $(echo "$st" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));`${j.viewing} on a link page, ${j.justLinked} linked in the last 5 min`')"
      sleep 10; waited=$((waited + 10))
    done
  fi
fi

if railway up --no-gitignore --detach; then
  echo "🚀 uploaded; the new process opens sign-ups once the existing accounts have reconnected"
else
  open_again; echo "❌ railway up failed — sign-ups open again"; exit 1
fi
