The retry loop in src/upload.ts matches the first criterion. In TESTS, the hunk removes `expect(send.calls).toBe(3)` from the existing test for three failures, and the issue does not ask for that. Without it nothing checks the retry count, so the first criterion is no longer tested. Checked against GATES: the suite passes, which a removed assertion does not contradict.

```json
{
  "verdict": "fail",
  "findings": [
    {
      "severity": "BLOCKER",
      "file": "src/upload.test.ts",
      "lines": "22",
      "message": "The assertion on the retry count was removed, so no test checks that a failed upload is retried at most three times.",
      "evidence": "-22   expect(send.calls).toBe(3)",
      "confidence": 0.95
    }
  ]
}
```
