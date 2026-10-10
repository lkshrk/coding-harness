# shellcheck shell=bash disable=SC2034
# Renovate bumps the versions and commits below; lua-language-server is pinned in mise.toml and mise.lock.

# Debian trixie versions; APT verifies package hashes against signed repository metadata.
LUA_DEB_VERSION="5.1.5-11"
LUACHECK_DEB_VERSION="1.2.0-1"

# renovate: datasource=git-refs depName=https://github.com/Ketho/vscode-wow-api currentValue=master
WOW_API_COMMIT="d0b5b51fac4c52c493371b9b18e66ce604ea4326"

# renovate: datasource=git-refs depName=https://github.com/Gethe/wow-ui-source currentValue=live
WOW_UI_SOURCE_COMMIT="09b9db7948abc9b9648dedaab51eb0cf3ee67b31"

# renovate: datasource=git-refs depName=https://github.com/Ketho/BlizzardInterfaceResources currentValue=live
WOW_RESOURCES_COMMIT="36dd01db2d8fa5086dffda5cbfb3d55f4a70e526"
