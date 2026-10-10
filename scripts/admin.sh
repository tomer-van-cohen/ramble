#!/bin/zsh
# Call the production admin API without printing or passing the password on the command line.
#
#   scripts/admin.sh GET  /admin/announce
#   scripts/admin.sh POST /admin/announce note.json      # a JSON body from a file
#
# The admin credentials are read from the service's Railway variables, as scripts/deploy.sh does.
set -u
SITE=${SITE:-https://ramble.baby}
method=$1 route=$2 body=${3:-}
creds=$(railway variables --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);const p=v.ADMIN_PASSWORD||v.DASHBOARD_PASSWORD||'';if(p)process.stdout.write((v.ADMIN_USER||'admin')+':'+p)}catch{}})")
[ -z "$creds" ] && { echo "no admin password in the Railway variables" >&2; exit 1; }
if [ -n "$body" ]; then
  printf 'user = "%s"\n' "$creds" | curl -sS -m 60 -K - -X "$method" -H "Origin: $SITE" -H 'content-type: application/json' --data-binary @"$body" "$SITE$route"
else
  printf 'user = "%s"\n' "$creds" | curl -sS -m 60 -K - -X "$method" -H "Origin: $SITE" "$SITE$route"
fi
echo
