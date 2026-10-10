#!/usr/bin/env bash
# Recompute the SHA256 pins in features/<name>/tools.sh from its *_URL functions, then run its lock.sh.
# usage: scripts/refresh-pins.sh [features/<name>|<name>...]   (default: every feature with a tools.sh)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/features"
if [ "$#" -eq 0 ]; then
  for tools in */tools.sh; do set -- "$@" "${tools%/tools.sh}"; done
fi

# Prints "<VAR> <url>" per pin for one architecture; only tools.sh is sourced, nothing is installed.
urls() {
  bash -c '
    set -euo pipefail
    source "$1/tools.sh"
    arch="$2"
    for fn in $(compgen -A function | grep -E "^[A-Z0-9_]+_URL$"); do
      printf "%s %s\n" "${fn%_URL}" "$("$fn")"
    done
  ' _ "$1" "$2"
}

# Renovate runs this without a shell and with containerbase, which installs missing tools on demand.
if ! command -v uv >/dev/null && command -v install-tool >/dev/null; then install-tool uv; fi

changed=0
for feature in "$@"; do
  feature="${feature#features/}"
  feature="${feature%%/*}"
  tools="$feature/tools.sh"
  [ -f "$tools" ] || { echo "$feature: no tools.sh" >&2; exit 2; }
  for arch in amd64 arm64; do
    upper="$(echo "$arch" | tr '[:lower:]' '[:upper:]')"
    while read -r pin url; do
      if grep -qE "^${pin}_SHA256=" "$tools"; then
        [ "$arch" = amd64 ] || continue
        var="${pin}_SHA256"
      else
        var="${pin}_SHA256_$upper"
      fi
      old="$(sed -nE "s/^$var=\"([0-9a-f]{64})\"$/\1/p" "$tools")"
      [ -n "$old" ] || { echo "$feature: $var is not pinned in tools.sh" >&2; exit 1; }
      new="$(curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 "$url" | sha256sum | cut -d' ' -f1)"
      if [ "$old" != "$new" ]; then
        sed -i.bak "s/^$var=\"$old\"$/$var=\"$new\"/" "$tools" && rm -f "$tools.bak"
        echo "$feature: $var $old -> $new"
        changed=1
      fi
    done < <(urls "$feature" "$arch")
  done
  [ ! -x "$feature/lock.sh" ] || "$feature/lock.sh"
done
[ "$changed" -eq 1 ] || echo "pins up to date"
