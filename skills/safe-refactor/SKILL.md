---
name: safe-refactor
description: Restructure code without changing its behaviour, with the same checks passing before the first edit and after the last. Use for extraction, consolidation, moves, renames and cleanup.
license: MIT
metadata:
  source: "JuliusBrussee/caveman skills/safe-refactor (MIT)"
---

# Safe refactor

Change the structure, keep the behaviour, and prove both.

## Baseline

- Before the first edit, run the checks that cover the code you will touch and every `VERIFY` command; record the results.
- A red baseline is not yours to fix: finish `BLOCKED` with `blocker.needs: environment` or `decision` and the failing output.
- When the touched code has no test, add a characterization test that pins its current output before changing it.

## Boundary

- Behaviour includes return values, errors, ordering, logging the tests read, public names and signatures, and file formats.
- Keep public interfaces unless the issue names the change; then update every caller in the same change.
- No feature work, bug fixes or dependency changes inside a refactor. A bug you find goes to `concerns`.

## Steps

- Move one boundary at a time: extract, inline, rename or relocate, then rerun the focused checks.
- Keep each intermediate state building and passing.
- Prefer the repository's own patterns over new abstractions; delete code the refactor makes dead.

## Stop

- The structure the issue asks for exists, and the baseline checks pass with the same results.
- `evidence` lists each check before the first edit and after the last.
- Existing assertions are unchanged; only imports and names they reference may move.
