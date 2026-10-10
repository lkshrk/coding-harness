#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: [PLATFORM=linux/amd64] features/test/build.sh <image-name> <feature>[=<options-json>]..." >&2
  exit 2
fi
image="$1"
shift
features="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$features/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/.devcontainer"

entries='"ghcr.io/devcontainers/features/common-utils:2": {"installZsh": false, "installOhMyZsh": false, "installOhMyZshConfig": false, "upgradePackages": false, "username": "none"}'
for arg in "$@"; do
  feature="${arg%%=*}"
  options="{}"
  [ "$arg" = "$feature" ] || options="${arg#*=}"
  cp -R "$features/$feature" "$work/.devcontainer/$feature"
  entries="$entries, \"./$feature\": $options"
done
order='[]'
[ ! -d "$work/.devcontainer/mise" ] || order='["./mise"]'
printf '{"image": "debian:trixie", "features": {%s}, "overrideFeatureInstallOrder": %s}\n' "$entries" "$order" \
  >"$work/.devcontainer/devcontainer.json"

"$root/node_modules/.bin/devcontainer" build --workspace-folder "$work" --image-name "$image" \
  ${PLATFORM:+--platform "$PLATFORM"}
