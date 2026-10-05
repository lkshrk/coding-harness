---
name: migration
description: Make a schema, data, API, protocol or configuration transition that stays compatible and can be rolled back. Use for migrations where readers and writers of the old shape must keep working.
license: MIT
metadata:
  source: "JuliusBrussee/caveman skills/migration (MIT)"
---

# Migration

Move from the old shape to the new one without breaking anything that still uses the old one.

## Map

- List every reader and writer of the old shape, the data that exists in it, and who owns each.
- State the forward path and the rollback path before editing; the rollback is part of the change, not an afterthought.

## Sequence

- Expand, migrate, verify, contract: add the new shape beside the old, move data and callers, prove both work, and remove the old only when the issue asks for that stage.
- Mixed versions may run at once during rollout; each step must be safe with old and new code side by side.
- Keep data: a destructive step (drop, delete, overwrite) needs explicit mention in the issue; otherwise stop before it.
- Make each step idempotent so a retry after a partial failure is safe, and make partial failure visible.

## Proof

- Test the forward path on data in the old shape, and the rollback path back to it.
- Run the old and the new readers against the migrated data where both exist.
- `evidence` names the rollback path and the check that proves it.

## Stop

- Stop after the stage the issue asks for passes. Never contract implicitly.
