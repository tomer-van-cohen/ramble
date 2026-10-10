#!/bin/sh
# Start as root only long enough to make the data volume writable by the
# unprivileged "node" user, then drop privileges for the whole runtime.
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R node:node "$DATA" 2>/dev/null || true
  chmod 700 "$DATA" 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  echo "⚠️  setpriv not available — running as root" >&2
fi
exec "$@"
