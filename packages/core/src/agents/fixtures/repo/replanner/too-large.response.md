The CSV writer is done and tested. Two independent pieces remain: the JSON writer and the route that uses both writers. Each has its own files and checks, and together they cover all three criteria of the original.

```json
{
  "action": "split",
  "sub_issues": [
    {
      "title": "Stream invoices as a JSON array",
      "description": "## Goal\n\nAdd a streaming JSON writer for invoices next to the existing CSV writer.\n\n## Why\n\nThe export route needs both formats; the CSV writer already landed in attempt 1.\n\n## Design excerpt\n\n[billing design § Export](https://linear.app/frg/document/billing-export-1a2b3c)\n\n## Interfaces in\n\nnone\n\n## Interfaces out\n\n* `writeJson(rows: AsyncIterable<Invoice>): ReadableStream`\n\n## Files\n\n* `src/export/json.ts`\n\n## Constraints\n\n* Stream rows; never hold all invoices in memory.\n\n## Out of scope\n\n* PDF export.\n\n## Acceptance criteria\n\n- [ ] `writeJson` streams a JSON array of invoices.\n\n## Tests expected\n\n* Unit tests for an empty and a multi-row stream.\n\n## Verify\n\n```sh\nbun test src/export\n```"
    },
    {
      "title": "Expose invoice export on the billing API",
      "description": "## Goal\n\nServe `GET /invoices/export?format=csv|json` using the CSV and JSON writers.\n\n## Why\n\nCustomers reconcile invoices in their own tools.\n\n## Design excerpt\n\n[billing design § Export](https://linear.app/frg/document/billing-export-1a2b3c)\n\n## Interfaces in\n\nnone\n\n## Interfaces out\n\n* `GET /invoices/export?format=csv|json`\n\n## Files\n\n* `src/routes/invoices.ts`\n\n## Constraints\n\n* Stream rows; never hold all invoices in memory.\n\n## Out of scope\n\n* PDF export.\n\n## Acceptance criteria\n\n- [ ] `format=csv` streams one row per invoice with a header row.\n- [ ] `format=json` streams a JSON array of invoices.\n- [ ] An unknown format returns 400.\n\n## Tests expected\n\n* Route tests for both formats and the 400 case.\n\n## Verify\n\n```sh\nbun test src/routes\n```"
    }
  ],
  "reason": "task_too_large: attempt 1 hit the step cap after src/export/csv.ts; the JSON writer and the route are separable and each verifiable on its own."
}
```
