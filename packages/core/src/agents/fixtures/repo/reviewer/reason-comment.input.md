--- BEGIN ISSUE ---
## Goal

Skip archived orders when syncing.

## Acceptance criteria

- [ ] Archived orders are not sent to the index.
--- END ISSUE ---

--- BEGIN LENS ---
Lens: acceptance
1. Archived orders are not sent to the index.
--- END LENS ---

--- BEGIN DIFF ---
diff --git a/scripts/sync.py b/scripts/sync.py
@@ -3,4 +3,6 @@ def sync(orders):
 3     batch = []
 4     for order in orders:
+5         # the index rejects the whole batch if any entry is archived
+6         if order.archived: continue
 7         batch.append(order)
 8     index.send(batch)
--- END DIFF ---

--- BEGIN TESTS ---
--- END TESTS ---

--- BEGIN GATES ---
test: pass (exit 0, 2.1s)
12 passed
--- END GATES ---
