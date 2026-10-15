# shellcheck shell=bash disable=SC2034,SC2154
# The one mise pin; every Feature's tools are pinned in its own mise.toml and mise.lock.

# renovate: datasource=github-releases depName=jdx/mise
MISE_VERSION="2026.10.11"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.11
MISE_SHA256_AMD64="f9612efcddda0ae55b62d3b6f82a6c860d5b54ebee0807d4f1a1d578055e1607"
# renovate-digest: datasource=github-release-attachments depName=jdx/mise digestVersion=v2026.10.11
MISE_SHA256_ARM64="370b4b4cfd740402e9a55aa1a8a01fbb1ac95c50af1207b2db2c5489dd4da0cd"
MISE_URL() { printf '%s' "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-$(pick x64 arm64)"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
