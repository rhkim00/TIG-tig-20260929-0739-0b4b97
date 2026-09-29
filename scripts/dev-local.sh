#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if [[ -x "$repo_dir/.local/runtime/node_modules/.bin/node" ]]; then
  export PATH="$repo_dir/.local/runtime/node_modules/.bin:$PATH"
fi
node -e 'if(Number(process.versions.node.split(".")[0]) !== 24) { console.error("Use Node 24; see .nvmrc."); process.exit(1); }'
# Reuse this server's existing local cluster. Other clones use the documented Docker DB.
pg_bin="$repo_dir/.local/postgres/root/usr/lib/postgresql/16/bin"
pg_data="$repo_dir/.local/postgres/data"
if [[ -x "$pg_bin/pg_ctl" && -f "$pg_data/PG_VERSION" ]]; then
  pg_lib="$repo_dir/.local/postgres/root/usr/lib/x86_64-linux-gnu"
  if ! LD_LIBRARY_PATH="$pg_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$pg_bin/pg_ctl" -D "$pg_data" status >/dev/null 2>&1; then
    LD_LIBRARY_PATH="$pg_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$pg_bin/pg_ctl" -D "$pg_data" -l "$repo_dir/.local/postgres/server.log" -o "-h 127.0.0.1 -p 55432 -k '$repo_dir/.local/postgres'" start
  fi
fi
npm run db:migrate
npm run db:seed
exec npm run dev
