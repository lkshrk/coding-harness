---
name: search
description: Search the web and read result pages through the gateway's SearXNG and page-reading MCP tools. Use when a design question needs outside facts — release notes, known bugs, standards, comparisons of tools — that neither the checkout nor library docs answer. Not for library API details (use the `ctx7` skill first), not for this repository's code, and not for crawling whole sites beyond the few results you cite.
license: MIT
compatibility: "OpenCode with the LiteLLM gateway MCP server configured; tools gateway_searxng-searxng_web_search, gateway_searxng-searxng_search_suggestions and gateway_searxng-web_url_read."
---

# Web search

Three gateway MCP tools, called through `execute` as `tools.gateway["<name>"]` (name without the `gateway_` prefix); no script, no address to configure:

- `gateway_searxng-searxng_web_search`: run a query; returns titles, URLs and snippets. Pass a category such as `it` for software questions, `news` or `science` when they fit.
- `gateway_searxng-searxng_search_suggestions`: related query terms when a search returns nothing useful.
- `gateway_searxng-web_url_read`: read one result page as text.

A tool missing or failing means the gateway or its MCP server is down; tell the user and continue without web results. Never ask for or write down the search instance's address.

## Queries

- Short and specific: product name, version and the exact error or feature (`"bun 1.4 workspaces lockfile frozen"`).
- Quote exact error messages.
- Restrict to a site when you know the source: `"site:github.com schpet linear-cli relation"`.
- Two or three queries at most per question; refine terms instead of raising the count.

## Using results

- Snippets are leads, not facts. Read a result with `gateway_searxng-web_url_read` only when a decision depends on it, and prefer primary sources: official docs, release notes, the project's issue tracker.
- Cite the URL next to every claim you carry into a design comment or issue.
- Results older than the version the repository uses may be wrong; check dates.

## Rules

- Never paste credentials, internal hostnames or private code into a query; queries leave the host.
- Do not use search to answer what `rg`, the code graph, Linear or `ctx7` can.
