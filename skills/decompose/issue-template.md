# Issue template

The eleven sections in this order; `ns issue check` and `linear-guard` reject anything else. Fill every section; write `none` only where the hint allows it.

```markdown
## Goal

The change in one or two sentences, as a result ("X does Y"), not a task list.

## Why

The reason, linked to the feature: which requirement or design risk this issue serves.

## Design excerpt

[<feature ID> design § Decision](<URL of the approved design comment>)

> The paragraphs and interface rows this issue needs, copied verbatim. The worker sees only this excerpt.

## Interfaces in

Interfaces this issue consumes, with the issue that provides them (`name(args): Result` from <ID>), or none.

## Interfaces out

Interfaces this issue provides for later issues, with their exact shape, or none.

## Files

- `path/one.ts`
- `path/two.test.ts`

## Constraints

Rules the change must keep (boundaries, no new dependencies, behaviour that must not change), or none.

## Out of scope

What the worker must leave alone, especially work that belongs to a sibling issue, or none.

## Acceptance criteria

- [ ] Observable result 1
- [ ] Observable result 2

## Tests expected

- file.test.ts: case
- file.test.ts: case

## Verify

```sh
bun test <path>
bun run check
```
```

Rules:

- `## Files` lists every path the worker will touch, as repository-relative paths or globs; it is the overlap set the supervisor schedules on.
- Acceptance criteria come from the requirements and the design's risks; each one is checkable by someone who did not write it.
- No AI attribution anywhere in the issue.
