--- BEGIN ISSUE ---
## Goal

Skip archived campsites when syncing.

## Acceptance criteria

- [ ] Archived campsites are not sent to the index.
--- END ISSUE ---

--- BEGIN LENS ---
Lens: acceptance
1. Archived campsites are not sent to the index.
--- END LENS ---

--- BEGIN DIFF ---
diff --git a/scripts/sync.py b/scripts/sync.py
@@ -3,4 +3,6 @@ def sync(campsites):
 3     batch = []
 4     for site in campsites:
+5         # the index rejects the whole batch if any entry is archived
+6         if site.archived: continue
 7         batch.append(site)
 8     index.send(batch)
--- END DIFF ---

--- BEGIN TESTS ---
--- END TESTS ---

--- BEGIN GATES ---
test: pass (exit 0, 2.1s)
12 passed
--- END GATES ---
