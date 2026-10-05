#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift/stack-node
bin=/usr/local/bin
cache=/var/cache/nightshift
package_managers="${PACKAGEMANAGERS:-}"

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

pick() {
  if [ "$arch" = amd64 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
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

find_node() {
  local node
  node="$(command -v node || true)"
  [ -n "$node" ] || [ ! -x /usr/local/share/nvm/current/bin/node ] || node=/usr/local/share/nvm/current/bin/node
  if [ -z "$node" ]; then
    echo "node not found; the node Feature must be installed first" >&2
    exit 1
  fi
  printf '%s' "$node"
}

wrapper() {
  local name="$1" target="$2" node="$3"
  cat >"$bin/$name" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$node" "$target" "\$@"
EOF
  chmod 0755 "$bin/$name"
}

prepare_cache() {
  mkdir -p "$cache/corepack" "$cache/npm" "$cache/pnpm-store" "$cache/pnpm-cache"
  chmod 1777 "$cache" "$cache/corepack" "$cache/npm" "$cache/pnpm-store" "$cache/pnpm-cache"
}

install_oxlint() {
  local triple archive
  triple="$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu)"
  archive="$(fetch "https://github.com/oxc-project/oxc/releases/download/oxlint_v$OXLINT_VERSION/oxlint-$triple.tar.gz" "$(sha OXLINT)" oxlint.tgz)"
  mkdir -p "$tmp/oxlint"
  tar -xzf "$archive" -C "$tmp/oxlint"
  install -m 0755 "$(find "$tmp/oxlint" -type f -name 'oxlint*' | head -n 1)" "$bin/oxlint"
}

install_npm_tools() {
  local node npm modules
  node="$1"
  npm="$(dirname "$node")/npm"
  mkdir -p "$prefix/npm"
  cp "$here/npm/package.json" "$here/npm/package-lock.json" "$prefix/npm/"
  npm_config_cache="$tmp/npm-cache" "$npm" ci --prefix "$prefix/npm" --omit=dev --ignore-scripts \
    --no-audit --no-fund --loglevel=error
  modules="$prefix/npm/node_modules/.bin"
  for tool in typescript-language-server vscode-eslint-language-server eslint prettier; do
    wrapper "$tool" "$(readlink -f "$modules/$tool")" "$node"
  done
}

prepare_package_managers() {
  local node corepack spec
  node="$1"
  corepack="$(dirname "$node")/corepack"
  export COREPACK_HOME="$cache/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  "$corepack" enable
  for spec in $package_managers; do
    case "$spec" in
      npm@* | pnpm@* | yarn@*) "$corepack" install -g "$spec" ;;
      *) echo "skipping packageManager $spec (not handled by the node stack)" ;;
    esac
  done
  chmod -R a+rwX "$cache/corepack"
}

ensure_packages
prepare_cache
node="$(find_node)"
install_oxlint
install_npm_tools "$node"
prepare_package_managers "$node"
