--- BEGIN ISSUE ---
## Goal

Add CSV and JSON export of invoices to the billing API.

## Why

Customers reconcile invoices in their own tools.

## Design excerpt

[billing design § Export](https://linear.app/frg/document/billing-export-1a2b3c)

## Interfaces in

none

## Interfaces out

* `GET /invoices/export?format=csv|json`

## Files

* `src/export/csv.ts`
* `src/export/json.ts`
* `src/routes/invoices.ts`

## Constraints

* Stream rows; never hold all invoices in memory.

## Out of scope

* PDF export.

## Acceptance criteria

- [ ] `format=csv` streams one row per invoice with a header row.
- [ ] `format=json` streams a JSON array of invoices.
- [ ] An unknown format returns 400.

## Tests expected

* Route tests for both formats and the 400 case.

## Verify

```sh
bun test src/export src/routes
```
--- END ISSUE ---

--- BEGIN FAILURE ---
class: task_too_large
evidence: worker hit the step cap after the CSV writer; JSON streaming and the route are untouched.
--- END FAILURE ---

--- BEGIN HISTORY ---
attempt 1: WORKER_NO_FINISH after 150 steps. Changed: src/export/csv.ts (CSV writer with streaming, tests pass). Not started: src/export/json.ts, src/routes/invoices.ts.
--- END HISTORY ---
