CSV: the route test on the integrated branch passes. JSON: the route test fails, the response lacks the array brackets, although FRG-302 reported its own tests passing. Throughput: no gate measures export time.

```json
{
  "criteria": [
    {
      "criterion": "Invoices can be exported as CSV.",
      "verdict": "met",
      "evidence": "(pass) GET /invoices/export?format=csv streams a header and one row per invoice"
    },
    {
      "criterion": "Invoices can be exported as JSON.",
      "verdict": "not_met",
      "evidence": "(fail) GET /invoices/export?format=json streams a JSON array: Expected \"[{\\\"id\\\":1}]\", Received \"{\\\"id\\\":1}\""
    },
    {
      "criterion": "Exports of 100k invoices finish within 10 seconds.",
      "verdict": "unverifiable",
      "evidence": "No gate or test measures export duration; a benchmark over 100k invoices is missing."
    }
  ]
}
```
