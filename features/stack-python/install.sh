#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift/stack-python
bin=/usr/local/bin
cache=/var/cache/nightshift
python="${PYTHONVERSION:-}"
python="${python:-$PYTHON_VERSION}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

if ! [[ "$python" =~ ^[0-9A-Za-z.,\<\>=!~*\ +-]+$ ]]; then
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

install_astral() {
  local name="$1" var="$2" triple archive tool
  shift 2
  triple="$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu)"
  archive="$(fetch "$("${var}_URL")" "$(sha "$var")" "$name.tgz")"
  tar -xzf "$archive" -C "$tmp"
  for tool in "$name" "$@"; do
    install -D -m 0755 "$tmp/$name-$triple/$tool" "$prefix/bin/$tool"
    ln -sf "$prefix/bin/$tool" "$bin/$tool"
  done
}

install_python() {
  export UV_PYTHON_INSTALL_DIR="$prefix/python" UV_PYTHON_BIN_DIR="$bin" UV_CACHE_DIR="$tmp/uv-cache"
  "$bin/uv" python install --default --preview-features python-install-default "$python"
  chmod -R a+rX "$prefix"
}

prepare_cache() {
  mkdir -p "$cache/uv"
  chmod 1777 "$cache"
  chmod -R a+rwX "$cache/uv"
}

ensure_packages
install_astral uv UV uvx
install_astral ruff RUFF
install_astral ty TY
install_python
prepare_cache
