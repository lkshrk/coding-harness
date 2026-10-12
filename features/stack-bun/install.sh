#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prefix=/opt/nightshift/stack-bun
bin=/usr/local/bin
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

locked() {
  (cd "$here" && MISE_DATA_DIR=/opt/nightshift/mise/data MISE_CACHE_DIR="$tmp/mise-cache" MISE_CONFIG_DIR="$tmp/mise-config" \
    MISE_STATE_DIR="$tmp/mise-state" MISE_TRUSTED_CONFIG_PATHS="$here" MISE_LOCKED=1 \
    /opt/nightshift/mise/bin/mise which "$1")
}

# The entry comes from the package's own bin field: the wrapper runs it with node, not its shebang.
bin_entry() {
  local name="$1" package="$2" node="$3"
  "$node" -e 'const [dir, name] = process.argv.slice(1); const b = require(dir + "/package.json").bin;
    process.stdout.write(require("path").resolve(dir, typeof b === "string" ? b : b[name]))' \
    "$(readlink -f "$prefix/npm/node_modules/$package")" "$name"
}

bun_install() {
  local bun
  bun="$(locked bun)"
  mkdir -p "$prefix/npm"
  cp "$here/npm/package.json" "$here/npm/bun.lock" "$prefix/npm/"
  (cd "$prefix/npm" && BUN_INSTALL_CACHE_DIR="$tmp/bun-cache" "$bun" install --frozen-lockfile --production \
    --linker hoisted --no-progress)
}

install_npm_tools() {
  local node
  node="$(find_node)"
  bun_install
  wrapper tsc "$(bin_entry tsc typescript "$node")" "$node"
}

prepare_cache() {
  mkdir -p "$deps/bun"
  chmod 1777 "$deps" "$deps/bun"
}

ensure_packages
"$mise_install" "$here" bun bunx biome oxlint
install_npm_tools
prepare_cache
