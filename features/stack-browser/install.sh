#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prefix=/opt/nightshift/stack-browser
bin=/usr/local/bin
browsers=/var/cache/nightshift/ms-playwright
version="${PLAYWRIGHTVERSION:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

if [ -n "$version" ] && ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid Playwright version '$version'" >&2
  exit 1
fi

if [ ! -x /opt/nightshift/mise/bin/mise ]; then
  echo "/opt/nightshift/mise/bin/mise not found; the mise Feature must be installed first" >&2
  exit 1
fi

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

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# bun stays off PATH: it installs only the stack's own tools.
mise() {
  (cd "$here" && MISE_DATA_DIR=/opt/nightshift/mise/data MISE_CACHE_DIR="$tmp/mise-cache" MISE_CONFIG_DIR="$tmp/mise-config" \
    MISE_STATE_DIR="$tmp/mise-state" MISE_TRUSTED_CONFIG_PATHS="$here" MISE_YES=1 MISE_LOCKED=1 \
    /opt/nightshift/mise/bin/mise "$@")
}

bun_run() {
  (cd "$prefix" && BUN_INSTALL_CACHE_DIR="$tmp/bun-cache" "$bun" "$@" --linker hoisted --no-progress)
}

node="$(find_node)"
mise install --locked
bun="$(mise which bun)"
mkdir -p "$prefix" "$browsers"
cp "$here/npm/package.json" "$here/npm/bun.lock" "$prefix/"
bun_run install --frozen-lockfile --production
locked_version="$("$node" -p 'require(process.argv[1]).dependencies.playwright' "$prefix/package.json")"
# The browser build must match the repository's Playwright; playwright pins playwright-core exactly.
if [ -n "$version" ] && [ "$version" != "$locked_version" ]; then
  bun_run add --exact "playwright@$version"
fi

cat >"$bin/playwright" <<WRAP
#!/usr/bin/env bash
set -euo pipefail
exec "$node" "$prefix/node_modules/playwright/cli.js" "\$@"
WRAP
chmod 0755 "$bin/playwright"

export DEBIAN_FRONTEND=noninteractive
PLAYWRIGHT_BROWSERS_PATH="$browsers" "$bin/playwright" install --with-deps --only-shell chromium
rm -rf /var/lib/apt/lists/*
chmod -R a+rX "$browsers" "$prefix"
