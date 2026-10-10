# shellcheck shell=bash disable=SC2034
# Release tools are pinned in mise.toml and mise.lock; semgrep is locked with pip hashes in semgrep.lock by lock.sh.

# renovate: datasource=pypi depName=semgrep
SEMGREP_VERSION="1.180.0"
