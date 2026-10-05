--- BEGIN ISSUE ---
## Goal

Trim whitespace from user names before saving.

## Acceptance criteria

- [ ] Leading and trailing whitespace is removed from the saved name.
--- END ISSUE ---

--- BEGIN LENS ---
Lens: correctness
1. The change does what each acceptance criterion says.
2. Edge cases of the changed lines are handled: empty input, null, unicode.
3. Error paths keep their previous behaviour.
--- END LENS ---

--- BEGIN DIFF ---
diff --git a/src/users.ts b/src/users.ts
@@ -4,5 +4,5 @@ export function saveUser(input: UserInput): User {
-4   const name = input.name
+4   const name = input.name.trim()
  5   return store.insert({ ...input, name })
 6 }
diff --git a/src/users.test.ts b/src/users.test.ts
@@ -30,0 +30,4 @@
+30 test('trims the name', () => {
+31   expect(saveUser({ name: '  Ada ' }).name).toBe('Ada')
+32 })
--- END DIFF ---

--- BEGIN TESTS ---
--- END TESTS ---

--- BEGIN GATES ---
test: pass (18 tests)
typecheck: pass
--- END GATES ---
