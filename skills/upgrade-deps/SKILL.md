---
name: upgrade-deps
description: Upgrade dependencies one at a time, each after reading its changelog and each verified before the next. Use for dependency-upgrade issues in any ecosystem.
license: MIT
metadata:
  source: "written for nightshift"
---

# Upgrade dependencies

One bump, one proof, one commit; then the next.

## Before a bump

- Detect the package manager and lockfile from the repository; use its own scripts for build and test.
- Read the changelog or release notes between the current and target version. Note breaking changes, deprecations, removed options and required migrations.
- A major version, a breaking note, a changelog you cannot find, or a jump over several majors is a doubt: flag it in `concerns` and finish `DONE_WITH_CONCERNS`.

## Bump

- Change one dependency per commit: manifest and lockfile together, within the declared range unless the issue asks to widen it.
- Do not mix unrelated bumps, refactors or feature changes into the same commit.
- Adapt call sites only where the changelog or a failing check requires it.

## Supply chain

- Prefer the version the issue names; do not pick a release published in the last 48 hours.
- Check that the package name is the one already in use; a new transitive dependency or a changed install script goes to `concerns`.

## Verify

- After each bump: build, typecheck and test with the repository's commands, then every `VERIFY` command.
- A failing bump is reverted, or fixed only where the changelog explains the break; never loosen a test to pass it.
- `evidence` lists per dependency: old and new version, the changelog read, and the check results. The rollback is reverting that commit.
