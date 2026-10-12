#!/usr/bin/env bash
set -euo pipefail

# Run the built image with --network=none; every tool must already be on PATH.
opencode --version
rtk --version
gh --version
rg --version
ast-grep --version
codebase-memory-mcp --version
gitleaks version
osv-scanner --version
actionlint --version
shellcheck --version
bats --version
semgrep --version
bash-language-server --version
dsh --version

dcp="$(jq -r .version /opt/nightshift/npm/node_modules/@tarquinen/opencode-dcp/package.json)"
if [ "$dcp" != 3.2.0 ]; then
  echo "@tarquinen/opencode-dcp is $dcp, expected 3.2.0" >&2
  exit 1
fi
test -f /opt/nightshift/npm/node_modules/@tarquinen/opencode-dcp/server.js

for tool in uv node npm mise; do
  if command -v "$tool" >/dev/null; then
    echo "$tool is on PATH; the agent layer keeps it private" >&2
    exit 1
  fi
done
