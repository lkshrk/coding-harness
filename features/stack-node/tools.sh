# shellcheck shell=bash disable=SC2034,SC2154
# Renovate bumps versions; scripts/refresh-pins.sh recomputes the checksums from the *_URL functions.

# renovate: datasource=npm depName=oxlint
OXLINT_VERSION="1.87.0"
OXLINT_SHA256_AMD64="97a075ac82cd6131641101016f79142ac6765ba79a5a582864450e30d192a425"
OXLINT_SHA256_ARM64="2226c5ac023135808a391a5f746666ca0fa398f05252b9007c329e4b62ae03c0"
OXLINT_URL() { printf '%s' "https://github.com/oxc-project/oxc/releases/download/oxlint_v$OXLINT_VERSION/oxlint-$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu).tar.gz"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
