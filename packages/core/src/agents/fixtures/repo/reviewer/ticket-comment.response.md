Line 6 skips archived sites before the batch is built, which meets the criterion. Line 5 adds a comment that cites the ticket ROU-123 and describes temporary state ("until the cutover drops them"); a cold reader cannot use either, so it is a blocker.

```json
{
  "verdict": "fail",
  "findings": [
    {
      "severity": "BLOCKER",
      "file": "scripts/sync.py",
      "lines": "5",
      "message": "The added comment cites a ticket ID and describes temporary state instead of a lasting fact; remove it.",
      "evidence": "+5         # ROU-123: skip archived sites until the cutover drops them",
      "confidence": 0.9
    }
  ]
}
```
