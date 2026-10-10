# shellcheck shell=bash disable=SC2034,SC2154
# Renovate bumps versions; scripts/refresh-pins.sh recomputes the checksums from the *_URL functions.

# renovate: datasource=custom.opencode-v2 depName=opencode
OPENCODE_VERSION="2.0.22"
OPENCODE_SHA256_AMD64="6414bc6a441ef28bc549984baf2f60fb95e8fe46713bd17293921400ddfe6d33"
OPENCODE_SHA256_ARM64="3f4df7efe28a53830777666e160984cf8247938e68f105b8ae1f9b4778febc2d"
OPENCODE_URL() { printf '%s' "https://opencode.ai/files/bin/$OPENCODE_VERSION/opencode-$(pick linux-x64-baseline linux-arm64).tar.gz"; }

# renovate: datasource=github-releases depName=rtk-ai/rtk
RTK_VERSION="0.51.0"
RTK_SHA256_AMD64="5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5"
RTK_SHA256_ARM64="8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632"
RTK_URL() { printf '%s' "https://github.com/rtk-ai/rtk/releases/download/v$RTK_VERSION/rtk-$(pick x86_64-unknown-linux-musl aarch64-unknown-linux-gnu).tar.gz"; }

# renovate: datasource=github-releases depName=cli/cli
GH_VERSION="2.102.0"
GH_SHA256_AMD64="bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386"
GH_SHA256_ARM64="7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484"
GH_URL() { printf '%s' "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_$arch.tar.gz"; }

# renovate: datasource=github-releases depName=BurntSushi/ripgrep
RIPGREP_VERSION="15.2.0"
RIPGREP_SHA256_AMD64="33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"
RIPGREP_SHA256_ARM64="a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d"
RIPGREP_URL() { printf '%s' "https://github.com/BurntSushi/ripgrep/releases/download/$RIPGREP_VERSION/ripgrep-$RIPGREP_VERSION-$(pick x86_64-unknown-linux-musl aarch64-unknown-linux-gnu).tar.gz"; }

# renovate: datasource=github-releases depName=ast-grep/ast-grep
AST_GREP_VERSION="0.45.3"
AST_GREP_SHA256_AMD64="f8ac830881339d1edee6b2652f54798c0f4da5a827f2db38a08ee31117783ce8"
AST_GREP_SHA256_ARM64="b39cfbc58da4b869a88b8a4bc57bd5deb0d24541e704cf7c257da7b53ec81c8f"
AST_GREP_URL() { printf '%s' "https://github.com/ast-grep/ast-grep/releases/download/$AST_GREP_VERSION/app-$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu).zip"; }

# renovate: datasource=github-releases depName=DeusData/codebase-memory-mcp
CODEBASE_MEMORY_VERSION="0.11.0"
CODEBASE_MEMORY_SHA256_AMD64="032b33c1833919a2d1de67ff6367fa6ea46aee8689c86ef223c88fae3b6e4536"
CODEBASE_MEMORY_SHA256_ARM64="c0e46c87cf37e35f1ac0bd9cc7e1d8b0ca4ef40034e1008805d709fa52a4e38a"
CODEBASE_MEMORY_URL() { printf '%s' "https://github.com/DeusData/codebase-memory-mcp/releases/download/v$CODEBASE_MEMORY_VERSION/codebase-memory-mcp-linux-$arch.tar.gz"; }

# renovate: datasource=github-releases depName=gitleaks/gitleaks
GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256_AMD64="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
GITLEAKS_SHA256_ARM64="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
GITLEAKS_URL() { printf '%s' "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_$(pick x64 arm64).tar.gz"; }

# renovate: datasource=github-releases depName=google/osv-scanner
OSV_SCANNER_VERSION="2.6.0"
OSV_SCANNER_SHA256_AMD64="ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108"
OSV_SCANNER_SHA256_ARM64="2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4"
OSV_SCANNER_URL() { printf '%s' "https://github.com/google/osv-scanner/releases/download/v$OSV_SCANNER_VERSION/osv-scanner_linux_$arch"; }

# renovate: datasource=github-releases depName=rhysd/actionlint
ACTIONLINT_VERSION="1.7.12"
ACTIONLINT_SHA256_AMD64="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
ACTIONLINT_SHA256_ARM64="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
ACTIONLINT_URL() { printf '%s' "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/actionlint_${ACTIONLINT_VERSION}_linux_$arch.tar.gz"; }

# renovate: datasource=github-releases depName=koalaman/shellcheck
SHELLCHECK_VERSION="0.11.0"
SHELLCHECK_SHA256_AMD64="b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6"
SHELLCHECK_SHA256_ARM64="68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc"
SHELLCHECK_URL() { printf '%s' "https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK_VERSION/shellcheck-v$SHELLCHECK_VERSION.linux.$(pick x86_64 aarch64).tar.gz"; }

# renovate: datasource=github-tags depName=bats-core/bats-core
BATS_VERSION="1.14.0"
BATS_SHA256="bb537b70b15b732f6d8827dd6578e3d8ce166636ce1f18ea9a074184fcce9177"
BATS_URL() { printf '%s' "https://github.com/bats-core/bats-core/archive/refs/tags/v$BATS_VERSION.tar.gz"; }

# renovate: datasource=github-releases depName=astral-sh/uv
UV_VERSION="0.12.23"
UV_SHA256_AMD64="9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6"
UV_SHA256_ARM64="6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f"
UV_URL() { printf '%s' "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu).tar.gz"; }

# renovate: datasource=python-version depName=python
PYTHON_VERSION="3.14.8"

# renovate: datasource=pypi depName=semgrep
SEMGREP_VERSION="1.179.0"

# renovate: datasource=node-version depName=node
NODE_VERSION="24.21.0"
NODE_SHA256_AMD64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_SHA256_ARM64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"
NODE_URL() { printf '%s' "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$(pick x64 arm64).tar.xz"; }

# Download URLs use $arch (amd64 or arm64), set by install.sh or refresh-pins.sh.
pick() { if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
