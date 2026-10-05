#!/usr/bin/env bash
# Usage: scripts/sync-host.sh <ssh-host> [remote-dir relative to the remote home]
set -euo pipefail

host=${1:?usage: scripts/sync-host.sh <ssh-host> [remote-dir]}
remote_dir=${2:-Dev/coding-harness}
root=$(cd "$(dirname "$0")/.." && pwd)
bun=$(command -v bun || echo "$HOME/.bun/bin/bun")
ssh_opts=(-o BatchMode=yes)
remote_path='export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"'
fingerprint='git ls-files -co --exclude-standard | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done > "${TMPDIR:-/tmp}/ns-files.$$"
git hash-object --stdin-paths < "${TMPDIR:-/tmp}/ns-files.$$" | paste "${TMPDIR:-/tmp}/ns-files.$$" - | git hash-object --stdin
rm -f "${TMPDIR:-/tmp}/ns-files.$$"'

start=$(date +%s)
ssh "${ssh_opts[@]}" "$host" "mkdir -p '$remote_dir'" </dev/null
rsync -a --delete \
  --exclude node_modules --exclude .venv --exclude runs/ --exclude dist/ \
  --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.tsbuildinfo' \
  --exclude '.claude/settings.local.json' \
  --exclude __pycache__ --exclude .pytest_cache --exclude .ruff_cache --exclude .DS_Store \
  -e "ssh ${ssh_opts[*]}" "$root/" "$host:$remote_dir/"

ssh "${ssh_opts[@]}" "$host" bash -s -- "$remote_dir" <<REMOTE
set -euo pipefail
$remote_path
cd "\$HOME/\$1"
stamp=node_modules/.nightshift-deps
sum=\$(cat bun.lock package.json packages/*/package.json | sha256sum | cut -d' ' -f1)
if [ ! -f "\$stamp" ] || [ "\$(cat "\$stamp")" != "\$sum" ]; then
  bun install --frozen-lockfile
  echo "\$sum" > "\$stamp"
else
  echo "dependencies unchanged"
fi
mkdir -p "\$HOME/.local/bin"
chmod +x packages/cli/src/main.ts
for name in ns nightshift; do ln -sfn "\$PWD/packages/cli/src/main.ts" "\$HOME/.local/bin/\$name"; done
REMOTE

local_version="$("$bun" "$root/packages/cli/src/main.ts" --version) $(cd "$root" && bash -c "$fingerprint")"
remote_version="$(ssh "${ssh_opts[@]}" "$host" "$remote_path; ns --version" </dev/null) $(
  ssh "${ssh_opts[@]}" "$host" "cd '$remote_dir' && bash -s" <<<"$fingerprint"
)"
echo "synced $host:$remote_dir in $(($(date +%s) - start))s"
echo "local:  $local_version"
echo "remote: $remote_version"
[ "$local_version" = "$remote_version" ] || { echo "version or tree mismatch" >&2; exit 1; }
