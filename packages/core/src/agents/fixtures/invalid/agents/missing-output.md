---
description: Reviews one diff against a checklist.
nightshift:
  kind: single_call
  role: reviewer
  output: schemas/reviewer.json
  budget: { prompt_words: 400, input_tokens: 6000 }
---
Classifies one failed run.

## Rules

- Pick one class.
- Use the gate output.
- Use unknown when unsure.

## Inputs

The attempt block.

## Procedure

1. Read the gate output.

## Output

One json object.
