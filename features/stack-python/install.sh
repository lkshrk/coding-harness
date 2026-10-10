#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift/stack-python
bin=/usr/local/bin
cache=/var/cache/nightshift
python="${PYTHONVERSION:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

if [ -n "$python" ] && ! [[ "$python" =~ ^[0-9A-Za-z.,\<\>=!~*\ +-]+$ ]]; then
  echo "invalid Python version request '$python'" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

sha() {
  local var="${1}_SHA256_${arch^^}"
  printf '%s' "${!var}"
}


tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  local url="$1" sum="$2" out="$tmp/$3"
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 -o "$out" "$url"
  if ! echo "$sum  $out" | sha256sum -c --quiet -; then
    echo "checksum mismatch for $url" >&2
    exit 1
  fi
  printf '%s' "$out"
}

ensure_packages() {
  local missing=()
  for tool in curl tar gzip; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  [ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  [ "${#missing[@]}" -eq 0 ] && return
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl tar gzip
  rm -rf /var/lib/apt/lists/*
}

install_mise_tools() {
  local mise tool path
  mise="$(fetch "$(MISE_URL)" "$(sha MISE)" mise)"
  chmod 0755 "$mise"
  export MISE_DATA_DIR="$prefix/mise" MISE_CACHE_DIR="$tmp/mise-cache" MISE_CONFIG_DIR="$tmp/mise-config"
  export MISE_STATE_DIR="$tmp/mise-state" MISE_YES=1 MISE_LOCKED=1
  "$mise" trust -q "$here/mise.toml"
  (cd "$here" && "$mise" install --locked)
  # Link the binaries themselves: workers run offline and must not resolve a repository's own mise or .tool-versions.
  for tool in uv uvx ruff ty; do
    path="$(cd "$here" && "$mise" which "$tool")"
    ln -sf "$path" "$bin/$tool"
  done
  mise_python="$(dirname "$(cd "$here" && "$mise" which python3)")"
}

install_python() {
  export UV_PYTHON_INSTALL_DIR="$prefix/python" UV_CACHE_DIR="$tmp/uv-cache"
  mkdir -p "$UV_PYTHON_INSTALL_DIR"
  if [ -z "$python" ] || PATH="$mise_python" UV_PYTHON_DOWNLOADS=never \
    "$bin/uv" python find --no-config --python-preference only-system "$python" >/dev/null 2>&1; then
    ln -sf "$mise_python/python3" "$bin/python3"
    ln -sf "$mise_python/python3" "$bin/python"
  else
    # The repository asks for a Python the locked one does not satisfy; uv verifies the download it installs.
    UV_PYTHON_BIN_DIR="$bin" "$bin/uv" python install --default --preview-features python-install-default "$python"
  fi
  chmod -R a+rX "$prefix"
}

prepare_cache() {
  mkdir -p "$cache/uv"
  chmod 1777 "$cache"
  chmod -R a+rwX "$cache/uv"
}

ensure_packages
install_mise_tools
install_python
prepare_cache
