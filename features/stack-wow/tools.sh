# shellcheck shell=bash disable=SC2034,SC2154
# lua-language-server is pinned in mise.toml and mise.lock; only the mise binary that installs it is pinned here.

# Debian trixie versions; APT verifies package hashes against signed repository metadata.
LUA_DEB_VERSION="5.1.5-11"
LUACHECK_DEB_VERSION="1.2.0-1"

# renovate: datasource=github-releases depName=jdx/mise
MISE_VERSION="2026.10.7"
MISE_SHA256_AMD64="6eb1b890e90818417ca34c90dbbd47881917d5cd199f31b63b062ea9c6b18d85"
MISE_SHA256_ARM64="c7108d85a32ba17e4747d31d4a42f39f0c134f16211e204e8ef0a49d4f518fe1"
MISE_URL() { printf '%s' "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-$(pick x64 arm64)"; }

# renovate: datasource=git-refs depName=https://github.com/Ketho/vscode-wow-api currentValue=master
WOW_API_COMMIT="d0b5b51fac4c52c493371b9b18e66ce604ea4326"

# renovate: datasource=git-refs depName=https://github.com/Gethe/wow-ui-source currentValue=live
WOW_UI_SOURCE_COMMIT="09b9db7948abc9b9648dedaab51eb0cf3ee67b31"

# renovate: datasource=git-refs depName=https://github.com/Ketho/BlizzardInterfaceResources currentValue=live
WOW_RESOURCES_COMMIT="36dd01db2d8fa5086dffda5cbfb3d55f4a70e526"

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
