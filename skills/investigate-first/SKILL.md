---
name: investigate-first
description: Gather evidence and rank explanations before anything changes. Use for investigations, unknown causes, intermittent behaviour, regressions, or a retry that failed for lack of context.
license: MIT
metadata:
  source: "JuliusBrussee/caveman skills/investigate-first (MIT)"
---

# Investigate first

Find out how the code actually behaves before anyone changes it.

## Evidence

- Separate the observed symptom from the suspected cause; write each down apart.
- Trace inputs, state transitions, ownership boundaries and failure output along the real path, from entry point to the effect.
- Prefer primary evidence: the code at `path:line`, `git log` and `git show` for when and why it changed, `cgc` for who calls what.

## Hypotheses

- List every explanation the evidence allows, not only the first.
- Rank them by how much evidence supports each and how cheaply each can be ruled out; check the cheapest first.
- Drop a hypothesis only on evidence, and note what ruled it out.

## Stop

- Stop when one mechanism explains all the evidence, or when the exact missing fact is known.
- A cause without proof is an `inferred` fact; an unanswered question goes to `open_questions`, never into a guess.
- Report the cause and its proof. Make no fix: the next worker gets your findings.
