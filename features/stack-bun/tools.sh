# shellcheck shell=bash disable=SC2034,SC2154
# Renovate bumps versions; scripts/refresh-pins.sh recomputes the checksums from the *_URL functions.

# renovate: datasource=npm depName=bun
BUN_VERSION="1.4.2"
BUN_SHA256_AMD64="c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"
BUN_SHA256_ARM64="54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"
BUN_URL() { printf '%s' "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$(pick x64-baseline aarch64).zip"; }

# renovate: datasource=npm depName=@biomejs/biome
BIOME_VERSION="2.5.15"
BIOME_SHA256_AMD64="5d867a0b2ccea1755b7e508b01d836a8c64e31a1e4d11ec24b43b6b4eec8b3b6"
BIOME_SHA256_ARM64="a56bcd73ddbfdb0f57a82bb67b7ea698eed4027aff602b95aa18fafe919d59e0"
BIOME_URL() { printf '%s' "https://github.com/biomejs/biome/releases/download/@biomejs/biome@$BIOME_VERSION/biome-linux-$(pick x64 arm64)"; }

# renovate: datasource=npm depName=oxlint
OXLINT_VERSION="1.87.0"
OXLINT_SHA256_AMD64="97a075ac82cd6131641101016f79142ac6765ba79a5a582864450e30d192a425"
OXLINT_SHA256_ARM64="2226c5ac023135808a391a5f746666ca0fa398f05252b9007c329e4b62ae03c0"
OXLINT_URL() { printf '%s' "https://github.com/oxc-project/oxc/releases/download/oxlint_v$OXLINT_VERSION/oxlint-$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu).tar.gz"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
