---
name: graph-query
description: Ask structural questions about the repository through its read-only code graph — outlines, callers, callees, definitions — before reading or grepping whole files. Use when locating code, judging the impact of a change, or finding every caller of a symbol.
license: MIT
---

# Graph query

The sandbox has a code-graph index of the base branch when `$NS_GRAPH_PROJECT` is set. It reflects the base commit, not your edits: use `git diff` for what you changed, and grep for text the graph does not model (strings, config, comments).

All commands: `codebase-memory-mcp cli --quiet <tool> --project "$NS_GRAPH_PROJECT" [flags]`. Paths are relative to the repository root.

## Tools

| Question | Tool and flags |
| --- | --- |
| What is in this file? | `get_file_outline --file-path <path>` |
| Where is a symbol defined? | `search_graph --name-pattern '<regex>'` (add `--label Function`, `Class`, `Method` to narrow) |
| Who calls it / what does it call? | `trace_path --function-name <name> --direction inbound` (or `outbound`), `--depth 1` for direct neighbours |
| Show the code of one symbol | `get_code_snippet --qualified-name <qn from search_graph>` |
| Text search with graph context | `search_code --pattern '<text>' --file-pattern '<glob>'` |

## Rules

- Start with an outline or a targeted search; read full files only for what you will edit.
- Before changing a function's signature or behaviour, list its inbound callers and check each one.
- No index (`$NS_GRAPH_PROJECT` empty or a command fails): fall back to `rg` and `ast-grep`; do not stop.
- Never try to re-index or write the index; it is mounted read-only.
