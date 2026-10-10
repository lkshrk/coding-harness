---
name: discover
description: "Turn a feature idea into approved requirements by asking the user one question at a time until nothing is unclear, then post them as a comment on the feature's parent issue. Use when a request is new or vague, or when a feature issue sits in the discovery stage. Not for designing the solution (`design`), splitting work (`decompose`) or bugs with a clear reproduction."
license: MIT
---

# Discover

Find out what the user wants before anyone decides how to build it. The output is a requirements comment the user approved, on the feature's parent issue. The description stays as it is: it must keep passing the issue template validator, which has no requirements section.

## Before asking

- Read what exists first; never ask what you can look up.
  - The parent issue and its comments (`linear issue view <ID>`), related issues (`linear issue query --search`).
  - The repository: `rg`, `git log`, the `code-graph` skill on the host index.
  - The vault: `~/knowledge/index.md`, then the project's pages.
- Keep a private list of open points. Each one is a fact or a decision the requirements need and that nothing above answers.

## Asking

- One question per message. Never batch two, even when they look related.
- Say what the answer unblocks, in one line: "This decides whether X needs Y."
- Offer concrete options when the space is small (2 to 4, recommended first, with the trade-off of each); ask open questions only when options would be guesses.
- After each answer, update the open-point list. A new point the answer raised goes on the list; a point the answer settled leaves it.
- Ask until the list is empty. There is no question limit; stop only when every requirement can be written without an assumption.
- If the user says "enough" or "you decide", write the remaining points as assumptions, each marked `^[assumed]`, and say so when presenting the draft.

## Writing the requirements

When the list is empty, draft the section and show it before writing anything:

```markdown
## Requirements (approved <date>)

### Goal
One or two sentences: what is true when this is done.

### Users and situations
Who uses it, when, and what they do today instead.

### Constraints
Technical, operational and product limits that any design must respect.

### Out of scope
What this feature explicitly does not cover.

### Acceptance criteria
Numbered, observable, checkable by someone who did not write them.

### Decisions from discovery
Each question that changed the scope, with the answer and the date.
```

- Ask: "Post these requirements on <ID>?" and wait for an explicit yes.
- After approval, post them as the user (`linear issue comment add <ID> --body-file /tmp/<ID>-requirements.md`). Never with a Nightshift app login: the supervisor treats app writes as its own.
- Changes requested after approval: show the changed lines, get approval again, and post the full updated section as a new comment saying what changed and why; the newest requirements comment is the current one.

## Done

- The parent issue has an approved requirements comment.
- No open point is left except those marked `^[assumed]`.
- Tell the user the next step is `design`, and stop. Do not start designing in the same turn.
