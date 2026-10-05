#!/usr/bin/env bash
# Usage: graph.sh <repository> <tool> [flags...]
# Queries the supervisor's code-graph index of <repository> read-only.
set -euo pipefail

repo=${1:?usage: graph.sh <repository> <tool> [flags...]}
tool=${2:?usage: graph.sh <repository> <tool> [flags...]}
shift 2

case "$tool" in
  search_graph | search_code | trace_path | get_file_outline | get_code_snippet | get_architecture) ;;
  *)
    echo "graph.sh: '$tool' is not a read tool" >&2
    exit 2
    ;;
esac

root=${NIGHTSHIFT_INDEX_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/nightshift/index}
db="$root/$repo/current/$repo.db"
if [ ! -f "$db" ]; then
  echo "graph.sh: no index for '$repo' at $db; fall back to rg" >&2
  exit 3
fi

# The shared index is never written: the CLI gets a private cache dir that links to it.
cache=$(mktemp -d "${TMPDIR:-/tmp}/ns-graph.XXXXXX")
trap 'rm -rf "$cache"' EXIT
ln -s "$db" "$cache/$repo.db"

CBM_CACHE_DIR=$cache HOME=$cache codebase-memory-mcp cli --quiet "$tool" --project "$repo" "$@"
