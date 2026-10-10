# shellcheck shell=bash disable=SC2034,SC2154
# Renovate bumps versions; scripts/refresh-pins.sh recomputes the checksums from the *_URL functions.

# renovate: datasource=github-releases depName=astral-sh/uv
UV_VERSION="0.12.23"
UV_SHA256_AMD64="9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6"
UV_SHA256_ARM64="6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f"
UV_URL() { printf '%s' "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu).tar.gz"; }

# renovate: datasource=github-releases depName=astral-sh/ruff
RUFF_VERSION="0.17.0"
RUFF_SHA256_AMD64="9567ff1201e2fb3da31ff04c35587d768c66d6cb42dfa84de474e2bfe360b608"
RUFF_SHA256_ARM64="dc0d74de837ef0a7bcc62ce98c48a622b075d057161f13b958be2934becd55a6"
RUFF_URL() { printf '%s' "https://github.com/astral-sh/ruff/releases/download/$RUFF_VERSION/ruff-$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu).tar.gz"; }

# renovate: datasource=github-releases depName=astral-sh/ty
TY_VERSION="0.0.86"
TY_SHA256_AMD64="0024ef2bf1e95a56fca6d8f9be44d4abf28ee44860b05095ad2bc3cff6a6c767"
TY_SHA256_ARM64="c40c4f4c72e1e7e29e71d2765b605b366393fa7e6296c903e0b21eb1927b59de"
TY_URL() { printf '%s' "https://github.com/astral-sh/ty/releases/download/$TY_VERSION/ty-$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu).tar.gz"; }

# Used when the repository declares no Python version; uv verifies the download it installs.
# renovate: datasource=python-version depName=python
PYTHON_VERSION="3.14.8"

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
