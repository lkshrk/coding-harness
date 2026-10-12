#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prefix=/opt/nightshift/stack-bun
bin=/usr/local/bin
cache=/var/cache/nightshift

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

# pnpm stays off PATH: it installs only the stack's own tools.
locked() {
  (cd "$here" && MISE_DATA_DIR=/opt/nightshift/mise/data MISE_CACHE_DIR="$tmp/mise-cache" MISE_CONFIG_DIR="$tmp/mise-config" \
    MISE_STATE_DIR="$tmp/mise-state" MISE_TRUSTED_CONFIG_PATHS="$here" MISE_LOCKED=1 \
    /opt/nightshift/mise/bin/mise which "$1")
}

# pnpm's .bin entries are shell shims, so the entry comes from the package's own bin field.
bin_entry() {
  local name="$1" package="$2" node="$3"
  "$node" -e 'const [dir, name] = process.argv.slice(1); const b = require(dir + "/package.json").bin;
    process.stdout.write(require("path").resolve(dir, typeof b === "string" ? b : b[name]))' \
    "$(readlink -f "$prefix/npm/node_modules/$package")" "$name"
}

pnpm_install() {
  local node="$1" pnpm
  pnpm="$(locked pnpm)"
  mkdir -p "$prefix/npm"
  cp "$here/npm/package.json" "$here/npm/pnpm-lock.yaml" "$prefix/npm/"
  PATH="$(dirname "$node"):$PATH" "$pnpm" install --dir "$prefix/npm" --frozen-lockfile --prod \
    --store-dir "$tmp/pnpm-store" --config.cache-dir="$tmp/pnpm-cache" --config.update-notifier=false \
    --reporter=append-only
}

install_npm_tools() {
  local node
  node="$(find_node)"
  pnpm_install "$node"
  wrapper tsc "$(bin_entry tsc typescript "$node")" "$node"
}

prepare_cache() {
  mkdir -p "$cache/bun"
  chmod 1777 "$cache" "$cache/bun"
}

ensure_packages
"$mise_install" "$here" bun bunx biome oxlint
install_npm_tools
prepare_cache
