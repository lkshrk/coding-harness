# shellcheck shell=bash disable=SC2034
# Renovate bumps versions only; update the per-arch checksums by hand.

# renovate: datasource=github-releases depName=astral-sh/uv
UV_VERSION="0.12.23"
UV_SHA256_AMD64="9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6"
UV_SHA256_ARM64="6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f"

# renovate: datasource=github-releases depName=astral-sh/ruff
RUFF_VERSION="0.16.10"
RUFF_SHA256_AMD64="9567ff1201e2fb3da31ff04c35587d768c66d6cb42dfa84de474e2bfe360b608"
RUFF_SHA256_ARM64="dc0d74de837ef0a7bcc62ce98c48a622b075d057161f13b958be2934becd55a6"

# renovate: datasource=github-releases depName=astral-sh/ty
TY_VERSION="0.0.86"
TY_SHA256_AMD64="336bb36b7e917d844b8b16925d373b4614b326e452c881ff4ed6bc5904b65185"
TY_SHA256_ARM64="d575243e0586742ae0e9186441358bd7e57e8160e319b3afb781430126762a39"

# Used when the repository declares no Python version; uv verifies the download it installs.
# renovate: datasource=python-version depName=python
PYTHON_VERSION="3.14.8"
