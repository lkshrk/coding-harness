# shellcheck shell=bash disable=SC2034,SC2154
# Renovate bumps versions and commits; scripts/refresh-pins.sh recomputes the checksums from the *_URL functions.

# Debian trixie versions; APT verifies package hashes against signed repository metadata.
LUA_DEB_VERSION="5.1.5-11"
LUACHECK_DEB_VERSION="1.2.0-1"

# renovate: datasource=github-releases depName=LuaLS/lua-language-server
LUA_LANGUAGE_SERVER_VERSION="3.19.1"
LUA_LANGUAGE_SERVER_SHA256_AMD64="e9235d2d72ef55bc41cf8c99cda2ed64777682024b4bb81f5dea425060c5cbb8"
LUA_LANGUAGE_SERVER_SHA256_ARM64="abd2572e8fc929dc838a81ffb8473c5bce0bf39bfe8edb4b120b3b623176ce83"
LUA_LANGUAGE_SERVER_URL() { printf '%s' "https://github.com/LuaLS/lua-language-server/releases/download/$LUA_LANGUAGE_SERVER_VERSION/lua-language-server-$LUA_LANGUAGE_SERVER_VERSION-linux-$(pick x64 arm64).tar.gz"; }

# renovate: datasource=git-refs depName=https://github.com/Ketho/vscode-wow-api currentValue=master
WOW_API_COMMIT="d0b5b51fac4c52c493371b9b18e66ce604ea4326"

# renovate: datasource=git-refs depName=https://github.com/Gethe/wow-ui-source currentValue=live
WOW_UI_SOURCE_COMMIT="09b9db7948abc9b9648dedaab51eb0cf3ee67b31"

# renovate: datasource=git-refs depName=https://github.com/Ketho/BlizzardInterfaceResources currentValue=live
WOW_RESOURCES_COMMIT="36dd01db2d8fa5086dffda5cbfb3d55f4a70e526"

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
