#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prefix=/opt/nightshift/stack-node
bin=/usr/local/bin
cache=/var/cache/nightshift
package_managers="${PACKAGEMANAGERS:-}"

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

install_npm_tools() {
  local node npm modules
  node="$1"
  npm="$(dirname "$node")/npm"
  mkdir -p "$prefix/npm"
  cp "$here/npm/package.json" "$here/npm/package-lock.json" "$prefix/npm/"
  npm_config_cache="$tmp/npm-cache" "$npm" ci --prefix "$prefix/npm" --omit=dev --ignore-scripts \
    --no-audit --no-fund --loglevel=error
  modules="$prefix/npm/node_modules/.bin"
  for tool in tsc vscode-eslint-language-server eslint prettier; do
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
"$mise_install" "$here" oxlint
install_npm_tools "$node"
prepare_package_managers "$node"
