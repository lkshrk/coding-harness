---
name: verify-and-stop
description: Prove that existing work meets its acceptance criteria without expanding scope. Use for acceptance checks, completion checks and focused gate runs.
license: MIT
metadata:
  source: "JuliusBrussee/caveman skills/verify-and-stop (MIT)"
---

# Verify and stop

Turn each acceptance criterion into the smallest proof that decides it, then stop.

## Proof

- One observable fact per criterion: a test, a command and its output, or a file state.
- Reuse results that still match the current commit; rerun only what is stale or missing.
- Run focused checks before wide ones.

## Verdicts

- `met`: the proof ran and shows the criterion holds.
- `not_met`: the proof ran and shows it does not hold, or the behaviour is absent.
- `unverifiable`: no proof could run or none decides it; name what is missing.
- A claim in a summary is not proof; the gate or test result is.

## Stop

- Do not fix, polish or add tests while verifying unless the task asks for fixes.
- Stop when every criterion has a verdict. Report the commands, their results and any remaining risk, nothing else.
