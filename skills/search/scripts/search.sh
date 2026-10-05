#!/usr/bin/env bash
# Usage: search.sh <query> [count] [category]
# Queries the searxng JSON API at $SEARXNG_URL and prints one result per block.
set -euo pipefail

query=${1:?usage: search.sh <query> [count] [category]}
count=${2:-8}
category=${3:-general}
base=${SEARXNG_URL:?SEARXNG_URL is not set; ask the user for the searxng address}

curl -fsS --max-time 20 -G "${base%/}/search" \
  --data-urlencode "q=$query" \
  --data-urlencode "format=json" \
  --data-urlencode "categories=$category" |
  jq -r --argjson n "$count" '
    .results[:$n][] |
    "\(.title)\n\(.url)\n\((.content // "") | gsub("\\s+"; " ") | .[:300])\n"'
