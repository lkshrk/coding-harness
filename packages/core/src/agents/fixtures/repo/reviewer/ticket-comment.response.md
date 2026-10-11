Line 6 skips archived orders before the batch is built, which meets the criterion. Line 5 adds a comment that cites the ticket ABC-123 and describes temporary state ("until the migration lands"); a cold reader cannot use either, so it is a blocker.

```json
{
  "verdict": "fail",
  "findings": [
    {
      "severity": "BLOCKER",
      "file": "scripts/sync.py",
      "lines": "5",
      "message": "The added comment cites a ticket ID and describes temporary state instead of a lasting fact; remove it.",
      "evidence": "+5         # ABC-123: skip archived orders until the migration lands",
      "confidence": 0.9
    }
  ]
}
```
