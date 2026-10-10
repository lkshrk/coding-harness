#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"
python="$(sed -nE 's/^python = "([0-9]+\.[0-9]+)\..*"$/\1/p' "$here/mise.toml")"
[ -n "$python" ] || { echo "mise.toml: no python version" >&2; exit 1; }

printf 'semgrep==%s\n' "$SEMGREP_VERSION" |
  uv pip compile --universal --generate-hashes --python-version "$python" --no-header -q - -o "$here/semgrep.lock"
(cd "$here/npm" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
