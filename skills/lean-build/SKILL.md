---
name: lean-build
description: Build the smallest complete slice that meets an issue's acceptance criteria. Use when implementing a feature or improvement where reuse, strict scope and a clear stop condition matter.
license: MIT
metadata:
  source: "JuliusBrussee/caveman skills/lean-build (MIT); test-first loop after mattpocock/skills tdd (MIT)"
---

# Lean build

Turn the issue into one complete, narrow outcome that fits the existing system.

## Scope

- Acceptance criteria are the target. Anything they do not ask for is a non-goal: extra modes, options, providers, config keys, extension points, polish.
- Add a dependency, service, config key or migration only when a criterion cannot pass without it, and name the trade-off in `concerns`.
- A criterion you cannot meet without leaving scope is a `BLOCKED` with `blocker.needs: decision`, not a quiet expansion.

## Placement

- Trace the entry point through the layers that own the behaviour and its invariants before writing code.
- Put each part of the change in the layer that owns it; do not squeeze a cross-layer change into one file or one call site.
- Reuse the helper, type or seam that already fits. Refactor only when patching around it would duplicate behaviour or hide the cause, and keep that refactor inside the files the change touches.

## Test-first loop

- One criterion at a time: one test, see it fail for the expected reason, the least code that makes it pass, then the next.
- Test behaviour through the public interface the issue names, not private helpers or call counts.
- Tidy only while the tests are green, and rerun them after.

## Stop

- Keep the repository runnable after each step.
- Stop when every criterion has a passing check and every `VERIFY` command passes. Do not keep improving.
- Report only material omissions, each with what would trigger the work.
