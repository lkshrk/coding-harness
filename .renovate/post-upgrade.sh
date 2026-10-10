#!/usr/bin/env bash
# Renovate postUpgradeTasks entry point (allowed by the runner config); arguments are package file directories.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
features=()
for dir in "$@"; do
  [[ "$dir" =~ ^features/[a-z0-9-]+(/[a-z0-9][a-z0-9._-]*)*$ && "$dir" != *..* ]] || { echo "ignoring $dir" >&2; continue; }
  features+=("$dir")
done
[ "${#features[@]}" -gt 0 ] || exit 0

# The Renovate image has containerbase but no uv or npm; lock.sh needs both, pinned to the Feature's versions.
for dir in "${features[@]}"; do
  feature="${dir#features/}"
  feature="${feature%%/*}"
  if [ ! -x "$root/features/$feature/lock.sh" ] || ! command -v install-tool >/dev/null; then continue; fi
  (
    # shellcheck source=/dev/null
    source "$root/features/$feature/tools.sh"
    command -v npm >/dev/null || install-tool node "$NODE_VERSION"
    command -v uv >/dev/null || { install-tool python "$PYTHON_VERSION" && install-tool uv "$UV_VERSION"; }
  )
done

exec bash "$root/scripts/refresh-pins.sh" "${features[@]}"
