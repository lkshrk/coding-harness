#!/usr/bin/env bash
# Usage: publish.sh <repository-dir> <ISSUE-ID> <design.md>
# Opens or updates a PR that adds docs/designs/<ISSUE-ID>.md, from a private worktree.
set -euo pipefail

usage='usage: publish.sh <repository-dir> <ISSUE-ID> <design.md>'
repo=${1:?$usage}
id=${2:?$usage}
src=${3:?$usage}

[[ "$id" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]] || { echo "publish.sh: '$id' is not an issue ID" >&2; exit 2; }
[ -f "$src" ] || { echo "publish.sh: no file $src" >&2; exit 2; }
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "publish.sh: $repo is not a git repository" >&2; exit 2; }

base=$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
base=${base:-main}
branch="design/$id"
target="docs/designs/$id.md"

git -C "$repo" fetch --quiet origin "$base"
if git -C "$repo" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git -C "$repo" fetch --quiet origin "$branch"
  start="origin/$branch"
else
  start="origin/$base"
fi

# The user's checkout stays untouched: all edits happen in a throwaway worktree.
work=$(mktemp -d "${TMPDIR:-/tmp}/ns-design.XXXXXX")
trap 'git -C "$repo" worktree remove --force "$work" >/dev/null 2>&1; rm -rf "$work"' EXIT
git -C "$repo" worktree add --quiet --detach "$work" "$start"

mkdir -p "$work/docs/designs"
cp "$src" "$work/$target"
git -C "$work" add -- "$target"
if [ -n "$(git -C "$work" status --porcelain -- . ':!'"$target")" ]; then
  echo "publish.sh: unexpected changes outside $target" >&2
  exit 1
fi
if git -C "$work" diff --cached --quiet; then
  echo "publish.sh: $target unchanged"
else
  if [ "$start" = "origin/$branch" ]; then msg="docs(design): update $id design"; else msg="docs(design): $id design"; fi
  git -C "$work" commit --quiet -m "$msg"
  git -C "$work" push --quiet origin "HEAD:refs/heads/$branch"
fi

url=$(cd "$work" && gh pr list --head "$branch" --state open --json url --jq '.[0].url')
if [ -z "$url" ]; then
  url=$(cd "$work" && gh pr create --base "$base" --head "$branch" --title "Design: $id" \
    --body "Design for $id. Review it here; merging approves it. Requirements and status stay on the Linear issue.")
fi
echo "$url"
