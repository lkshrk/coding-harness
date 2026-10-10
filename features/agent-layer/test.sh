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

for tool in uv node npm mise; do
  if command -v "$tool" >/dev/null; then
    echo "$tool is on PATH; the agent layer keeps it private" >&2
    exit 1
  fi
done
