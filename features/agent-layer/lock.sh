#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

printf 'semgrep==%s\n' "$SEMGREP_VERSION" |
  uv pip compile --universal --generate-hashes --python-version "${PYTHON_VERSION%.*}" --no-header -q - -o "$here/semgrep.lock"
(cd "$here/npm" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
