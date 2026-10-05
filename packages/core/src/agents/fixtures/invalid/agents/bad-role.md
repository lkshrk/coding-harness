---
description: Implements one feature issue end to end.
steps: 40
permission:
  "*": allow
nightshift:
  kind: worker
  role: Worker
  budget: { prompt_words: 600, input_tokens: 16000 }
---
Fixes one bug.

## Rules

- Reproduce first.
- Change little.
- Keep tests.

## Inputs

The issue block.

## Procedure

1. Fix it.

## Escalate

When blocked.

## Output

Call finish.
