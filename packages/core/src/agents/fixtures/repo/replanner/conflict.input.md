--- BEGIN ISSUE ---
## Goal

Cache invoice totals in the API process.

## Why

Totals are recomputed on every request.

## Design excerpt

[billing design § Totals](https://linear.app/frg/document/billing-totals-4d5e6f)

## Interfaces in

none

## Interfaces out

none

## Files

* `src/invoices/totals.ts`

## Constraints

none

## Out of scope

none

## Acceptance criteria

- [ ] A second request for the same invoice reads the cached total.

## Tests expected

* Unit test with a counting total function.

## Verify

```sh
bun test src/invoices
```
--- END ISSUE ---

--- BEGIN FAILURE ---
class: architectural_conflict
evidence: reviewer BLOCKER: "the API runs as several stateless replicas (design § Deployment); an in-process cache serves stale totals after an invoice update on another replica".
--- END FAILURE ---

--- BEGIN HISTORY ---
attempt 1: DONE, review fail with the BLOCKER above.
--- END HISTORY ---
