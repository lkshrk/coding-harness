#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

deps=/var/cache/nightshift-deps

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
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
  for tool in curl tar gzip gcc; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  [ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  [ -f /usr/include/stdlib.h ] || missing+=(libc6-dev)
  [ "${#missing[@]}" -eq 0 ] && return
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl tar gzip gcc libc6-dev
  rm -rf /var/lib/apt/lists/*
}

prepare_cache() {
  mkdir -p "$deps/go/mod" "$deps/go/build" "$deps/go/golangci-lint"
  chmod 1777 "$deps"
  chmod -R a+rwX "$deps/go"
}

ensure_packages
# Building gopls must not fill the image's copy of the runtime cache paths, which the shared mount hides.
export GOMODCACHE="$tmp/gomod" GOCACHE="$tmp/gobuild" GOPATH="$tmp/gopath" GOTOOLCHAIN=local GOFLAGS=-modcacherw
"$mise_install" "$here" go gofmt gofumpt gopls golangci-lint
prepare_cache
