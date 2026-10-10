#!/usr/bin/env bash
# Renovate postUpgradeTasks entry point (allowed by the runner config); arguments are package file directories.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
features=()
for dir in "$@"; do
  [[ "$dir" =~ ^features/[a-z0-9-]+(/[a-z0-9][a-z0-9._-]*)*$ && "$dir" != *..* ]] || { echo "ignoring $dir" >&2; continue; }
  features+=("$dir")
done
[ "${#features[@]}" -eq 0 ] || exec bash "$root/scripts/refresh-pins.sh" "${features[@]}"
