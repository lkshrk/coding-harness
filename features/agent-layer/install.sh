#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools.sh
source "$here/tools.sh"

prefix=/opt/nightshift
bin=/usr/local/bin

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "only Debian-based images are supported" >&2
  exit 1
fi

mise_install=/opt/nightshift/mise/bin/nightshift-mise-install
if [ ! -x "$mise_install" ]; then
  echo "$mise_install not found; the mise Feature must be installed first" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "$@"
  rm -rf /var/lib/apt/lists/*
}

# uv, python and node stay off PATH: they serve semgrep and the npm tools, not the worker.
locked() {
  (cd "$here" && MISE_DATA_DIR="$prefix/mise/data" MISE_CACHE_DIR="$tmp/mise-cache" MISE_CONFIG_DIR="$tmp/mise-config" \
    MISE_STATE_DIR="$tmp/mise-state" MISE_TRUSTED_CONFIG_PATHS="$here" MISE_LOCKED=1 \
    "$prefix/mise/bin/mise" which "$1")
}

install_semgrep() {
  local uv python
  if ! grep -qx "semgrep==$SEMGREP_VERSION \\\\" "$here/semgrep.lock"; then
    echo "semgrep.lock does not pin semgrep $SEMGREP_VERSION; run lock.sh" >&2
    exit 1
  fi
  uv="$(locked uv)"
  python="$(locked python3)"
  export UV_NO_CACHE=1 UV_PYTHON_DOWNLOADS=never
  "$uv" venv -q --python "$python" "$prefix/semgrep"
  "$uv" pip install -q --python "$prefix/semgrep/bin/python" --require-hashes --no-deps -r "$here/semgrep.lock"
  cat >"$bin/semgrep" <<EOS
#!/usr/bin/env bash
set -euo pipefail
export SEMGREP_SEND_METRICS="\${SEMGREP_SEND_METRICS:-off}" SEMGREP_ENABLE_VERSION_CHECK=0
exec "$prefix/semgrep/bin/semgrep" "\$@"
EOS
  chmod 0755 "$bin/semgrep"
}

# pnpm's .bin entries are shell shims, so the entry comes from the package's own bin field.
bin_entry() {
  local name="$1" package="$2" node="$3"
  "$node" -e 'const [dir, name] = process.argv.slice(1); const b = require(dir + "/package.json").bin;
    process.stdout.write(require("path").resolve(dir, typeof b === "string" ? b : b[name]))' \
    "$(readlink -f "$prefix/npm/node_modules/$package")" "$name"
}

wrapper() {
  local name="$1"
  shift
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\nexec'
    printf ' %q' "$@"
    printf ' "$@"\n'
  } >"$bin/$name"
  chmod 0755 "$bin/$name"
}

# Only the native package matching the architecture installs: optionalDependencies with os and cpu fields.
native_opencode() {
  local native=("$prefix"/npm/node_modules/@opencode/cli-linux-*/bin/opencode)
  if [ "${#native[@]}" -ne 1 ] || [ ! -x "${native[0]}" ]; then
    echo "expected one @opencode/cli native package, found: ${native[*]}" >&2
    exit 1
  fi
  readlink -f "${native[0]}"
}

install_npm_tools() {
  local node pnpm bls dsh bats opencode
  node="$(locked node)"
  pnpm="$(locked pnpm)"
  mkdir -p "$prefix/npm"
  cp "$here/npm/package.json" "$here/npm/pnpm-lock.yaml" "$here/npm/.npmrc" "$prefix/npm/"
  PATH="$(dirname "$node"):$PATH" "$pnpm" install --dir "$prefix/npm" --frozen-lockfile --prod \
    --store-dir "$tmp/pnpm-store" --config.cache-dir="$tmp/pnpm-cache" --config.update-notifier=false \
    --reporter=append-only
  bls="$(bin_entry bash-language-server bash-language-server "$node")"
  dsh="$(bin_entry dsh @deepseek-ai/dsh "$node")"
  bats="$(readlink -f "$prefix/npm/node_modules/bats/bin/bats")"
  opencode="$(native_opencode)"
  wrapper bash-language-server "$node" "$bls"
  wrapper dsh "$node" "$dsh"
  wrapper bats "$bats"
  wrapper opencode "$opencode"
}

install_scripts() {
  install -m 0755 "$here"/bin/* "$bin/"
  install -m 0644 "$here/profile.d/nightshift-ca.sh" /etc/profile.d/nightshift-ca.sh
}

apt_install ca-certificates curl git jq tar gzip xz-utils unzip
mkdir -p "$prefix"
"$mise_install" "$here" rtk gh rg ast-grep codebase-memory-mcp gitleaks osv-scanner actionlint shellcheck
install_semgrep
install_npm_tools
install_scripts
