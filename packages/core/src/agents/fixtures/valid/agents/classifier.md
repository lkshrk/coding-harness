---
description: Classifies a failed run into one failure class with a short reason.
temperature: 0
nightshift:
  kind: single_call
  role: classifier
  output: schemas/classifier.json
  reasoning: free_then_json
  budget:
    prompt_words: 400
    input_tokens: 6000
---
Classifies one failed run into a failure class.

## Rules

- Pick exactly one class from the schema.
- Base the class on the gate output, not on the worker's summary.
- Use `unknown` when the evidence does not fit any class.

## Inputs

The task message contains `--- BEGIN ATTEMPT ---` and `--- BEGIN GATES ---` blocks.

## Procedure

1. Read the gate output.
2. Compare it with the worker's summary.
3. Pick the class and write the reason.

## Output

Reason briefly, then end with one fenced json block matching the schema.
