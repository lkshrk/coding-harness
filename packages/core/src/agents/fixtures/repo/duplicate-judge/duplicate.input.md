--- BEGIN ISSUE ---
FRG-210: Saved user names keep surrounding spaces
Labels: bug
Saving "  Ada " should store "Ada", but keeps surrounding spaces.
--- END ISSUE ---

--- BEGIN CANDIDATE ---
FRG-205: Trim user names before saving
Status: Backlog
Labels: bug
Remove surrounding whitespace when storing a user's name.
--- END CANDIDATE ---
