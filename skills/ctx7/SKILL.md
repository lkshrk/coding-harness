---
name: ctx7
description: Look up current library and framework documentation with the Context7 CLI (`ctx7`). Use when a design or issue depends on a library's API, options or version behaviour and the checkout's code does not settle it. Not for this repository's own code (use `rg` or the `code-graph` skill), not for general web questions (use the `search` skill), and not for setup or login commands.
license: MIT
compatibility: "ctx7 0.5.12 (Context7 CLI, `npx ctx7` / `bunx ctx7`); jq for JSON filtering. Works without login at the public rate limit."
---

# Library docs

Two steps: resolve the library ID, then ask one question per call.

## Resolve

```sh
ctx7 library <name> "<what you want to know>" --json \
  | jq -r '.[:5][] | "\(.id)  trust=\(.trustScore)  snippets=\(.totalSnippets)  versions=\(.versions | join(","))"'
```

Pick the ID whose title matches the package the repository actually depends on (check `package.json`, `pyproject.toml` or the lockfile first). Prefer the official repository or website with a high trust score; note version IDs when the repository pins an older major.

## Query

```sh
ctx7 docs <libraryId> "<one topic>"
ctx7 docs /honojs/hono "cors middleware options"
```

- One concept per query; ask a second query rather than combining topics, unless the question is how two of them interact.
- Use the version the repository pins when the library lists versions (`/org/project/<version>`).
- Output is markdown with a `Source:` link per snippet; cite that link in the design Document when a decision depends on it.

## Rules

- Never run `ctx7 setup`, `remove`, `login`, `logout` or `upgrade`; they change the host configuration.
- Library docs describe the latest release unless a version ID is used: compare with the version in the lockfile before relying on an API.
- No result or the wrong library after two attempts: fall back to the `search` skill.
