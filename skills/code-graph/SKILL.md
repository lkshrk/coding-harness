---
name: code-graph
description: Ask structural questions about a repository through the host's read-only code-graph index (outlines, definitions, callers, callees, architecture) before reading whole files. Use when planning a change, estimating its impact, or deciding file sets for issues. Not for text the graph does not model (strings, config and comments need `rg`), not for uncommitted or branch work (the index is the base branch), and never to build or refresh an index.
license: MIT
compatibility: "codebase-memory-mcp 0.11 (the indexer the supervisor uses); bash. Index under ~/.cache/nightshift/index/<repo>/current/."
---

# Code graph

The supervisor indexes each repository's base branch into `~/.cache/nightshift/index/<repo>/<sha>/`, with `current` pointing at the latest. Query it only through the wrapper, which links the index into a throwaway cache so the shared one is never written:

```sh
<skill base directory>/scripts/graph.sh <repo> <tool> [flags]
```

`<repo>` is the repository name from the nightshift config (the directory under `~/Dev`). Always call the script by its absolute path; the shell permission matches only that form. Paths in flags and results are relative to the repository root.

## Tools

| Question | Tool and flags |
| --- | --- |
| Shape of the repository | `get_architecture` (add `--aspects '["structure","layers"]'` for more) |
| What is in this file? | `get_file_outline --file-path <path>` |
| Where is a symbol defined? | `search_graph --name-pattern '<regex>'` (narrow with `--label Function`, `Class`, `Method`, `Type`) |
| Who calls it / what does it call? | `trace_path --function-name <name> --direction inbound` (or `outbound`), `--depth 1` for direct neighbours |
| Code of one symbol | `get_code_snippet --qualified-name <qn from search_graph>` |
| Text with graph context | `search_code --pattern '<text>' --file-pattern '<glob>'` |

## Planning patterns

- File set of an issue: outline the files you expect to change, then `trace_path --direction inbound --depth 1` on each changed function; callers that must change join `## Files`, the rest go to the issue's context.
- Two issues may run in parallel only if their file sets are disjoint; check shared callers with `trace_path` before claiming that.
- Size: many inbound callers across packages means the change is larger than it looks; split or sequence it.

## Exit codes

- `2`: the tool is not on the read list; only the tools above are allowed.
- `3`: no index for that repository yet; fall back to `rg` and `git`, and tell the user the index is missing (`ns doctor` reports it).

## Rules

- Never call `codebase-memory-mcp` directly, never `index_repository`, `delete_project` or `manage_adr`: they write the index.
- The index lags the branch: confirm a finding in the checkout with `rg` or `git show` before it goes into an issue.
