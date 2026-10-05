---
name: gh
description: Read pull requests, CI checks, workflow runs and GitHub issues with the `gh` CLI, filtered with `--json` and `--jq`. Use when asked about a nightshift PR, why CI failed, or what changed in a branch on GitHub. Not for writing (no merge, comment, review, close or push), not for Linear issues (use the `linear` skill), and not for local diffs (use `git diff` or `ns diff`).
license: MIT
compatibility: "gh 2.48 or newer (verified on 2.102.0); `gh pr checks --json` is missing before 2.48."
---

# GitHub

Read-only. Run inside the checkout under `~/Dev/<repo>` or pass `--repo owner/name`.

## Pull requests

| Question | Command |
| --- | --- |
| Open PRs | `gh pr list --json number,title,headRefName,isDraft --jq '.[] \| "\(.number) \(.headRefName) \(.title)"'` |
| PR for an issue branch | `gh pr list --head ns/ABC-12-1 --state all --json number,state,url` |
| One PR | `gh pr view 42 --json title,state,mergeable,reviewDecision,body,files --jq '{title,state,mergeable,reviewDecision,files:[.files[].path]}'` |
| Diff | `gh pr diff 42 --name-only`, then `gh pr diff 42` for the content |
| Review comments | `gh pr view 42 --json reviews,comments --jq '.reviews[] \| "\(.author.login) \(.state): \(.body)"'` |

## Checks and runs

| Question | Command |
| --- | --- |
| Check state | `gh pr checks 42 --json name,state,bucket,link --jq '.[] \| select(.bucket != "pass") \| "\(.bucket) \(.name) \(.link)"'` |
| Check state, older gh | `gh pr view 42 --json statusCheckRollup --jq '.statusCheckRollup[] \| "\(.conclusion // .status) \(.name)"'` |
| Recent runs of a branch | `gh run list --branch ns/ABC-12-1 --limit 5 --json databaseId,workflowName,conclusion,status` |
| Why a run failed | `gh run view <id> --json jobs --jq '.jobs[] \| select(.conclusion == "failure") \| .name'`, then `gh run view <id> --log-failed \| tail -100` |

## Issues

`gh issue view 7 --json title,state,body,labels` for GitHub issues linked from Linear.

## Rules

- Never run `gh pr merge`, `gh pr comment`, `gh pr review`, `gh pr close`, `gh run rerun`, `gh api` or `gh auth`; merging and CI reruns go through `ns` and the user.
- Limit logs: always pipe `--log-failed` through `tail` or `rg`.
- Quote the failing check or log line when you report a cause.
