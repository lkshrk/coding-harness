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

apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "$@"
  rm -rf /var/lib/apt/lists/*
}

install_opencode() {
  local triple archive
  triple="$(pick linux-x64-baseline linux-arm64)"
  archive="$(fetch "$(OPENCODE_URL)" "$(sha OPENCODE)" opencode.tgz)"
  tar -xzf "$archive" -C "$tmp" opencode
  install -m 0755 "$tmp/opencode" "$bin/opencode"
}

install_rtk() {
  local triple archive
  triple="$(pick x86_64-unknown-linux-musl aarch64-unknown-linux-gnu)"
  archive="$(fetch "$(RTK_URL)" "$(sha RTK)" rtk.tgz)"
  tar -xzf "$archive" -C "$tmp" rtk
  install -m 0755 "$tmp/rtk" "$bin/rtk"
}

install_gh() {
  local dir="gh_${GH_VERSION}_linux_$arch" archive
  archive="$(fetch "$(GH_URL)" "$(sha GH)" gh.tgz)"
  tar -xzf "$archive" -C "$tmp" "$dir/bin/gh"
  install -m 0755 "$tmp/$dir/bin/gh" "$bin/gh"
}

install_ripgrep() {
  local dir archive
  dir="ripgrep-$RIPGREP_VERSION-$(pick x86_64-unknown-linux-musl aarch64-unknown-linux-gnu)"
  archive="$(fetch "$(RIPGREP_URL)" "$(sha RIPGREP)" rg.tgz)"
  tar -xzf "$archive" -C "$tmp" "$dir/rg"
  install -m 0755 "$tmp/$dir/rg" "$bin/rg"
}

install_ast_grep() {
  local triple archive
  triple="$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu)"
  archive="$(fetch "$(AST_GREP_URL)" "$(sha AST_GREP)" ast-grep.zip)"
  unzip -q -o "$archive" ast-grep -d "$tmp"
  install -m 0755 "$tmp/ast-grep" "$bin/ast-grep"
}

install_codebase_memory() {
  local archive
  archive="$(fetch "$(CODEBASE_MEMORY_URL)" "$(sha CODEBASE_MEMORY)" cbm.tgz)"
  tar -xzf "$archive" -C "$tmp" codebase-memory-mcp
  install -m 0755 "$tmp/codebase-memory-mcp" "$bin/codebase-memory-mcp"
}

install_gitleaks() {
  local archive
  archive="$(fetch "$(GITLEAKS_URL)" "$(sha GITLEAKS)" gitleaks.tgz)"
  tar -xzf "$archive" -C "$tmp" gitleaks
  install -m 0755 "$tmp/gitleaks" "$bin/gitleaks"
}

install_osv_scanner() {
  local binary
  binary="$(fetch "$(OSV_SCANNER_URL)" "$(sha OSV_SCANNER)" osv-scanner)"
  install -m 0755 "$binary" "$bin/osv-scanner"
}

install_actionlint() {
  local archive
  archive="$(fetch "$(ACTIONLINT_URL)" "$(sha ACTIONLINT)" actionlint.tgz)"
  tar -xzf "$archive" -C "$tmp" actionlint
  install -m 0755 "$tmp/actionlint" "$bin/actionlint"
}

install_shellcheck() {
  local dir="shellcheck-v$SHELLCHECK_VERSION" archive
  archive="$(fetch "$(SHELLCHECK_URL)" "$(sha SHELLCHECK)" shellcheck.tgz)"
  tar -xzf "$archive" -C "$tmp" "$dir/shellcheck"
  install -m 0755 "$tmp/$dir/shellcheck" "$bin/shellcheck"
}

install_bats() {
  local archive
  archive="$(fetch "$(BATS_URL)" "$BATS_SHA256" bats.tgz)"
  tar -xzf "$archive" -C "$tmp"
  "$tmp/bats-core-$BATS_VERSION/install.sh" "$prefix/bats" >/dev/null
  ln -sf "$prefix/bats/bin/bats" "$bin/bats"
}

install_semgrep() {
  local triple archive
  if ! grep -qx "semgrep==$SEMGREP_VERSION \\\\" "$here/semgrep.lock"; then
    echo "semgrep.lock does not pin semgrep $SEMGREP_VERSION; run lock.sh" >&2
    exit 1
  fi
  triple="$(pick x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu)"
  archive="$(fetch "$(UV_URL)" "$(sha UV)" uv.tgz)"
  tar -xzf "$archive" -C "$tmp" "uv-$triple/uv"
  export UV_PYTHON_INSTALL_DIR="$prefix/python" UV_NO_CACHE=1 UV_PYTHON_PREFERENCE=only-managed
  "$tmp/uv-$triple/uv" venv -q --python "$PYTHON_VERSION" "$prefix/semgrep"
  "$tmp/uv-$triple/uv" pip install -q --python "$prefix/semgrep/bin/python" --require-hashes --no-deps -r "$here/semgrep.lock"
  cat >"$bin/semgrep" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export SEMGREP_SEND_METRICS="\${SEMGREP_SEND_METRICS:-off}" SEMGREP_ENABLE_VERSION_CHECK=0
exec "$prefix/semgrep/bin/semgrep" "\$@"
EOF
  chmod 0755 "$bin/semgrep"
}

install_bash_language_server() {
  local dir archive entry
  dir="node-v$NODE_VERSION-linux-$(pick x64 arm64)"
  archive="$(fetch "$(NODE_URL)" "$(sha NODE)" node.txz)"
  mkdir -p "$prefix/node" "$prefix/npm"
  tar -xJf "$archive" -C "$prefix/node" --strip-components=1
  cp "$here/npm/package.json" "$here/npm/package-lock.json" "$prefix/npm/"
  PATH="$prefix/node/bin:$PATH" npm ci --prefix "$prefix/npm" --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  rm -rf /root/.npm
  entry="$(readlink -f "$prefix/npm/node_modules/.bin/bash-language-server")"
  cat >"$bin/bash-language-server" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$prefix/node/bin/node" "$entry" "\$@"
EOF
  chmod 0755 "$bin/bash-language-server"
  entry="$(readlink -f "$prefix/npm/node_modules/.bin/dsh")"
  cat >"$bin/dsh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$prefix/node/bin/node" "$entry" "\$@"
EOF
  chmod 0755 "$bin/dsh"
}

install_scripts() {
  install -m 0755 "$here"/bin/* "$bin/"
  install -m 0644 "$here/profile.d/nightshift-ca.sh" /etc/profile.d/nightshift-ca.sh
}

apt_install ca-certificates curl git jq tar gzip xz-utils unzip
mkdir -p "$prefix"
install_opencode
install_rtk
install_gh
install_ripgrep
install_ast_grep
install_codebase_memory
install_gitleaks
install_osv_scanner
install_actionlint
install_shellcheck
install_bats
install_semgrep
install_bash_language_server
install_scripts
