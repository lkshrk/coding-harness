# shellcheck shell=bash disable=SC2034,SC2154
# The one mise pin; every Feature's tools are pinned in its own mise.toml and mise.lock.

# renovate: datasource=github-releases depName=jdx/mise
MISE_VERSION="2026.10.10"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.10
MISE_SHA256_AMD64="7d79972e15549b286dcf9e25ef8c4fcef3d9fd7c0332d11cdfbc7d2842c418be"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.10
MISE_SHA256_ARM64="3978fbccfa2284b12e46cbf6df53cae118ec1f2fa780b6a204e6c9c792b620f6"
MISE_URL() { printf '%s' "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-$(pick x64 arm64)"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
