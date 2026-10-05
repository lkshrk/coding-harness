---
name: search
description: Search the web through the user's searxng instance (JSON API) and get titles, URLs and snippets. Use when a design question needs outside facts — release notes, known bugs, standards, comparisons of tools — that neither the checkout nor library docs answer. Not for library API details (use the `ctx7` skill first), not for this repository's code, and not for fetching or crawling whole pages beyond the few results you cite.
license: MIT
compatibility: "bash, curl and jq; a searxng instance with the JSON format enabled, its base URL in the SEARXNG_URL environment variable."
---

# Web search

```sh
<skill base directory>/scripts/search.sh "<query>" [count=8] [category=general]
```

Always call the script by its absolute path; the shell permission matches only that form. It calls `$SEARXNG_URL/search?format=json` and prints, per result, the title, the URL and up to 300 characters of snippet.

- Categories: `general`, `it`, `news`, `science`. Use `it` for software questions.
- `SEARXNG_URL` unset: the script stops with a message; ask the user for the address instead of guessing one. Never write the address into a skill, issue or document.
- `curl` fails (exit 22 or 28): the instance is down or rejects JSON; tell the user and continue without web results.

## Queries

- Short and specific: product name, version and the exact error or feature (`"bun 1.4 workspaces lockfile frozen"`).
- Quote exact error messages.
- Restrict to a site when you know the source: `"site:github.com schpet linear-cli relation"`.
- Two or three queries at most per question; refine terms instead of raising the count.

## Using results

- Snippets are leads, not facts. Open a result only when a decision depends on it (`webfetch` asks the user), and prefer primary sources: official docs, release notes, the project's issue tracker.
- Cite the URL next to every claim you carry into a design Document or issue.
- Results older than the version the repository uses may be wrong; check dates.

## Rules

- Never paste credentials, internal hostnames or private code into a query; queries leave the host.
- Do not use search to answer what `rg`, the code graph, Linear or `ctx7` can.
