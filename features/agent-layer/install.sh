#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift
bin=/usr/local/bin

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "only Debian-based images are supported" >&2
  exit 1
fi

mise_install=/opt/nightshift/mise/bin/nightshift-mise-install
if [ ! -x "$mise_install" ]; then
  echo "$mise_install not found; the mise Feature must be installed first" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "$@"
  rm -rf /var/lib/apt/lists/*
}

# uv, python and node stay off PATH: they serve semgrep and the npm tools, not the worker.
locked() {
  (cd "$here" && MISE_DATA_DIR="$prefix/mise/data" MISE_CACHE_DIR="$tmp/mise-cache" MISE_CONFIG_DIR="$tmp/mise-config" \
    MISE_STATE_DIR="$tmp/mise-state" MISE_TRUSTED_CONFIG_PATHS="$here" MISE_LOCKED=1 \
    "$prefix/mise/bin/mise" which "$1")
}

install_semgrep() {
  local uv python
  if ! grep -qx "semgrep==$SEMGREP_VERSION \\\\" "$here/semgrep.lock"; then
    echo "semgrep.lock does not pin semgrep $SEMGREP_VERSION; run lock.sh" >&2
    exit 1
  fi
  uv="$(locked uv)"
  python="$(locked python3)"
  export UV_NO_CACHE=1 UV_PYTHON_DOWNLOADS=never
  "$uv" venv -q --python "$python" "$prefix/semgrep"
  "$uv" pip install -q --python "$prefix/semgrep/bin/python" --require-hashes --no-deps -r "$here/semgrep.lock"
  cat >"$bin/semgrep" <<EOS
#!/usr/bin/env bash
set -euo pipefail
export SEMGREP_SEND_METRICS="\${SEMGREP_SEND_METRICS:-off}" SEMGREP_ENABLE_VERSION_CHECK=0
exec "$prefix/semgrep/bin/semgrep" "\$@"
EOS
  chmod 0755 "$bin/semgrep"
}

node_wrapper() {
  local name="$1" node="$2" entry
  entry="$(readlink -f "$prefix/npm/node_modules/.bin/$name")"
  cat >"$bin/$name" <<EOS
#!/usr/bin/env bash
set -euo pipefail
exec "$node" "$entry" "\$@"
EOS
  chmod 0755 "$bin/$name"
}

install_npm_tools() {
  local node
  node="$(locked node)"
  mkdir -p "$prefix/npm"
  cp "$here/npm/package.json" "$here/npm/package-lock.json" "$prefix/npm/"
  PATH="$(dirname "$node"):$PATH" npm_config_cache="$tmp/npm-cache" npm ci --prefix "$prefix/npm" --omit=dev \
    --ignore-scripts --no-audit --no-fund --loglevel=error
  node_wrapper bash-language-server "$node"
  node_wrapper dsh "$node"
}

install_scripts() {
  install -m 0755 "$here"/bin/* "$bin/"
  install -m 0644 "$here/profile.d/nightshift-ca.sh" /etc/profile.d/nightshift-ca.sh
}

apt_install ca-certificates curl git jq tar gzip xz-utils unzip
mkdir -p "$prefix"
"$mise_install" "$here" opencode rtk gh rg ast-grep codebase-memory-mcp gitleaks osv-scanner actionlint shellcheck bats
install_semgrep
install_npm_tools
install_scripts
