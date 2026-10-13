# shellcheck shell=bash disable=SC2034,SC2154
# The one mise pin; every Feature's tools are pinned in its own mise.toml and mise.lock.

# renovate: datasource=github-releases depName=jdx/mise
MISE_VERSION="2026.10.9"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.9
MISE_SHA256_AMD64="6ab6646b52b83f6bbd51c9d0d3ae54264ffa90efd1ac6d7c0ec5a86bbc6a0030"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.9
MISE_SHA256_ARM64="e5cf4820b0d3fd47776acf7811c855a52277262d35dcda1a9e8754e6d5442a39"
MISE_URL() { printf '%s' "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-$(pick x64 arm64)"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
