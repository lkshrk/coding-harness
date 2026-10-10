#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift/mise

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
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
  for tool in curl unzip tar gzip; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  [ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  [ "${#missing[@]}" -eq 0 ] && return
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl unzip tar gzip
  rm -rf /var/lib/apt/lists/*
}

ensure_packages
mise="$(fetch "$(MISE_URL)" "$(sha MISE)" mise)"
# Not on PATH: workers must not resolve a repository's own mise.toml or .tool-versions.
install -D -m 0755 "$mise" "$prefix/bin/mise"
install -D -m 0755 "$here/nightshift-mise-install" "$prefix/bin/nightshift-mise-install"
mkdir -p "$prefix/data"
