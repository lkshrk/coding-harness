#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift/stack-browser
bin=/usr/local/bin
browsers=/var/cache/nightshift/ms-playwright
version="${PLAYWRIGHTVERSION:-}"
version="${version:-$PLAYWRIGHT_VERSION}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid Playwright version '$version'" >&2
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

node="$(find_node)"
npm="$(dirname "$node")/npm"
mkdir -p "$prefix" "$browsers"
printf '{"name":"nightshift-stack-browser","private":true}\n' >"$prefix/package.json"
npm_config_cache="$tmp/npm-cache" "$npm" install --prefix "$prefix" --save-exact --ignore-scripts \
  --no-audit --no-fund --loglevel=error "playwright@$version"

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
