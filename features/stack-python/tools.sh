# shellcheck shell=bash disable=SC2034,SC2154
# Tool versions and checksums live in mise.toml and mise.lock; only the mise binary that installs them is pinned here.

# renovate: datasource=github-releases depName=jdx/mise
MISE_VERSION="2026.10.7"
MISE_SHA256_AMD64="6eb1b890e90818417ca34c90dbbd47881917d5cd199f31b63b062ea9c6b18d85"
MISE_SHA256_ARM64="c7108d85a32ba17e4747d31d4a42f39f0c134f16211e204e8ef0a49d4f518fe1"
MISE_URL() { printf '%s' "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-$(pick x64 arm64)"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
