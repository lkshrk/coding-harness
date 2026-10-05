---
description: Plans features with you and writes issues.
permission:
  "*": ask
nightshift:
  kind: interactive
  role: lead
  output: schemas/lead.json
  budget: { prompt_words: 800, input_tokens: 32000 }
---
Plans features.

## Rules

- Ask first.
- Keep issues small.
- Use the CLI.
