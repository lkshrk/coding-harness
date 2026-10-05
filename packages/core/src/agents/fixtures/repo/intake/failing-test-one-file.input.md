--- BEGIN ISSUE ---
FRG-210: Saved user names keep surrounding spaces

Steps: create a user with the name "  Ada ". Expected the saved name "Ada"; got "  Ada ".

Reproduction: the test below fails on main.

    test('trims the name', () => {
      expect(saveUser({ name: '  Ada ' }).name).toBe('Ada')
    })

The name is stored in `src/users.ts`, `saveUser`.

Labels: autopilot
--- END ISSUE ---

--- BEGIN PROJECTS ---
- Omni: the web app and its API; repositories: omni
- Billing: invoices and payment providers; repositories: billing
--- END PROJECTS ---

--- BEGIN SIMILAR ---
- FRG-188: Allow unicode in user names (Done)
- FRG-201: Email addresses are not lower-cased (Backlog)
--- END SIMILAR ---
