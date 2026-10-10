#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift/stack-bun
bin=/usr/local/bin
cache=/var/cache/nightshift

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

install_mise_tools() {
  local mise tool path
  mise="$(fetch "$(MISE_URL)" "$(sha MISE)" mise)"
  chmod 0755 "$mise"
  export MISE_DATA_DIR="$prefix/mise" MISE_CACHE_DIR="$tmp/mise-cache" MISE_CONFIG_DIR="$tmp/mise-config"
  export MISE_STATE_DIR="$tmp/mise-state" MISE_YES=1 MISE_LOCKED=1
  "$mise" trust -q "$here/mise.toml"
  (cd "$here" && "$mise" install --locked)
  # Link the binaries themselves: workers run offline and must not resolve a repository's own mise or .tool-versions.
  for tool in bun bunx biome oxlint; do
    path="$(cd "$here" && "$mise" which "$tool")"
    ln -sf "$path" "$bin/$tool"
  done
}

install_npm_tools() {
  local node npm
  node="$(find_node)"
  npm="$(dirname "$node")/npm"
  mkdir -p "$prefix/npm"
  cp "$here/npm/package.json" "$here/npm/package-lock.json" "$prefix/npm/"
  npm_config_cache="$tmp/npm-cache" "$npm" ci --prefix "$prefix/npm" --omit=dev --ignore-scripts \
    --no-audit --no-fund --loglevel=error
  wrapper typescript-language-server \
    "$(readlink -f "$prefix/npm/node_modules/.bin/typescript-language-server")" "$node"
}

prepare_cache() {
  mkdir -p "$cache/bun"
  chmod 1777 "$cache" "$cache/bun"
}

ensure_packages
install_mise_tools
install_npm_tools
prepare_cache
