---
name: surgical-patch
description: Reproduce a defect, find its cause and fix it at the narrowest layer that owns it. Use for bug fixes and for repairing a change that failed gates or review.
license: MIT
metadata:
  source: "JuliusBrussee/caveman skills/surgical-patch (MIT); root cause before fix after obra/superpowers skills/systematic-debugging (MIT)"
---

# Surgical patch

Prove the defect, explain it, then make the smallest change that removes it.

## Reproduce

- Before any fix, get a red-capable check: a test or command that fails now for the reported reason. Prefer a regression test in the existing suite; a one-off command counts when no test fits.
- Read the whole error, stack trace and failing assertion; note file, line and code.
- No reliable reproduction means no fix yet: gather more evidence or finish `NEEDS_CONTEXT` with what is missing.

## Diagnose

- Write down three to five falsifiable hypotheses, each with the observation that would rule it out.
- Check the cheapest first. Trace the bad value back to where it is produced; fix there, not where it shows.
- Debug output you add carries a `nightshift-debug` tag so it can be found and removed.
- After three fixes that each failed, stop patching: the cause is structural. Finish `BLOCKED` with `blocker.needs: decision`.

## Fix

- Change the layer that owns the wrong behaviour; leave callers, names and unrelated code as they are.
- One change at a time, then rerun the reproducing check; no cleanup or refactor on the side.
- Never loosen, skip or delete an assertion to make a check pass.

## Stop

- The reproducing check passes, the nearest affected tests pass, every `VERIFY` command passes.
- `rg nightshift-debug` finds nothing.
- `evidence` lists the reproducing check twice: failing before the fix, passing after.
