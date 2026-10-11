# shellcheck shell=bash disable=SC2034,SC2154
# The one mise pin; every Feature's tools are pinned in its own mise.toml and mise.lock.

# renovate: datasource=github-releases depName=jdx/mise
MISE_VERSION="2026.10.8"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.8
MISE_SHA256_AMD64="c72477ae6c3a8e7d817a322f43da70e4643e75ee5c21265f1c19c894273b7428"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.8
MISE_SHA256_ARM64="6ee0bd8173f1347514f4974d55fb1fae13aa7f6de0a55338adbefa0667cad7e5"
MISE_URL() { printf '%s' "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-$(pick x64 arm64)"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
