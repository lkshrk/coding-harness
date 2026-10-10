#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prefix=/opt/nightshift/stack-python
bin=/usr/local/bin
cache=/var/cache/nightshift
python="${PYTHONVERSION:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

if ! [[ "$python" =~ ^[0-9A-Za-z.,\<\>=!~*\ +-]*$ ]]; then
  echo "invalid Python version request '$python'" >&2
  exit 1
fi

mise_install=/opt/nightshift/mise/bin/nightshift-mise-install
if [ ! -x "$mise_install" ]; then
  echo "$mise_install not found; the mise Feature must be installed first" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

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

# The locked python is the default; uv installs the repository's request only when it does not satisfy it.
install_python() {
  export UV_PYTHON_INSTALL_DIR="$prefix/python" UV_PYTHON_BIN_DIR="$bin" UV_CACHE_DIR="$tmp/uv-cache"
  mkdir -p "$UV_PYTHON_INSTALL_DIR"
  if [ -n "$python" ] && ! UV_PYTHON_DOWNLOADS=never "$bin/uv" python find "$python" >/dev/null 2>&1; then
    "$bin/uv" python install --default --force --preview-features python-install-default "$python"
  fi
  chmod -R a+rX "$prefix"
}

prepare_cache() {
  mkdir -p "$cache/uv"
  chmod 1777 "$cache"
  chmod -R a+rwX "$cache/uv"
}

ensure_packages
"$mise_install" "$here" uv uvx ruff ty python python3
install_python
prepare_cache
