#!/usr/bin/env bash
# Recompute the SHA256 pins in features/<name>/tools.sh for the versions it names, then run its lock.sh.
# usage: scripts/refresh-pins.sh [<feature>|features/<feature>...]   (default: every feature with a tools.sh)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/features"
if [ "$#" -eq 0 ]; then
  for tools in */tools.sh; do set -- "$@" "${tools%/tools.sh}"; done
fi

# Prints "<pin> <url>" for every fetch the install_* calls of install.sh make on one architecture.
urls() {
  local feature="$1" arch="$2"
  bash -s "$feature" "$arch" 3>&1 >/dev/null 2>&1 <<'EOF'
feature="$1" arch="$2"
here="$PWD/$feature"
source "$here/tools.sh"
eval "$(awk '/^[a-z_]+\(\) \{$/,/^}$/' "$here/install.sh")"
pick() { if [ "$arch" = amd64 ]; then printf %s "$1"; else printf %s "$2"; fi; }
sha() { printf %s "$1"; }
fetch() { printf '%s %s\n' "$2" "$1" >&3; exit 0; }
tmp=/nonexistent prefix=/nonexistent bin=/nonexistent cache=/nonexistent
last="$(grep -n '^}$' "$here/install.sh" | tail -1 | cut -d: -f1)"
tail -n +"$((last + 1))" "$here/install.sh" | grep -E '^install_[a-z_]+( |$)' | while read -r call; do
  (eval "$call") </dev/null || true
done
EOF
}

changed=0
for feature in "$@"; do
  feature="${feature#features/}"
  tools="$feature/tools.sh"
  [ -f "$tools" ] || { echo "$feature: no tools.sh" >&2; exit 2; }
  for arch in amd64 arm64; do
    while read -r pin url; do
      if [[ "$pin" =~ ^[0-9a-f]{64}$ ]]; then
        # Architecture-independent pins are passed to fetch by value, not by name.
        [ "$arch" = amd64 ] || continue
        var="$(sed -nE "s/^([A-Z0-9_]+)=\"$pin\"$/\1/p" "$tools")"
      else
        var="${pin}_SHA256_$(echo "$arch" | tr '[:lower:]' '[:upper:]')"
      fi
      old="$(sed -nE "s/^$var=\"([0-9a-f]{64})\"$/\1/p" "$tools")"
      [ -n "$old" ] || { echo "$feature: $var is not pinned in tools.sh" >&2; exit 1; }
      new="$(curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 "$url" | sha256sum | cut -d' ' -f1)"
      if [ "$old" != "$new" ]; then
        sed -i.bak "s/^$var=\"$old\"$/$var=\"$new\"/" "$tools" && rm -f "$tools.bak"
        echo "$feature: $var $old -> $new"
        changed=1
      fi
    done < <(urls "$feature" "$arch" | sort -u)
  done
  [ ! -x "$feature/lock.sh" ] || "$feature/lock.sh"
done
[ "$changed" -eq 1 ] || echo "pins up to date"
