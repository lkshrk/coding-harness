# Design file template

`docs/designs/<ID>.md` in the feature's repository. Keep the headings exactly; `decompose` links child issues to them with `#<heading>` anchors.

```markdown
# <ID>: <feature title>

Requirements: <requirements comment URL on the parent issue> (approved <date>)

## Investigation

What exists today and what the feature touches.

- `path/to/module.ts`: what it does, how the feature relates to it.
- Constraints from the code: patterns, boundaries, pinned behaviour.
- Recorded decisions and pitfalls that apply (vault page links).

## Alternatives

### A: <short name>
How it works. What it changes (files, interfaces). Cost and risk. What it makes easier or harder later.

### B: <short name>
Same shape as A.

## Critique

- **A:** weaknesses against the requirements and constraints.
- **B:** weaknesses against the requirements and constraints.

## Decision

Chosen: <A, B or a synthesis>, because <reasons tied to the critique>.

Rejected: <alternative>, because <reason>.

Remaining risks and how they are caught: <risk> → <test, gate or review check>.

## Interfaces

| Interface | Shape | Owner (part) | Used by |
| --- | --- | --- | --- |
| `name` | signature, event or file format | part that defines it | parts that consume it |
```

Child issues created by `decompose` reference the merged design with:

```markdown
## Design excerpt

[<ID> § Decision](https://github.com/<owner>/<repo>/blob/main/docs/designs/<ID>.md#decision)

<the paragraphs and interface rows this issue needs, copied verbatim>
```

Workers also have the whole file in their checkout.
