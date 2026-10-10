# Design comment template

A comment on the feature's parent issue. Keep the headings exactly; child issues and the vault page point to them by name.

```markdown
## Design (<draft for review | approved>, <date>)

Requirements: the approved requirements comment on this issue (<date>).
<For a revision: one line saying what changed since the previous design comment.>

### Investigation

What exists today and what the feature touches.

- `path/to/module.ts`: what it does, how the feature relates to it.
- Constraints from the code: patterns, boundaries, pinned behaviour.
- Recorded decisions and pitfalls that apply (vault page links).

### Alternatives

#### A: <short name>
How it works. What it changes (files, interfaces). Cost and risk. What it makes easier or harder later.

#### B: <short name>
Same shape as A.

### Critique

- **A:** weaknesses against the requirements and constraints.
- **B:** weaknesses against the requirements and constraints.

### Decision

Chosen: <A, B or a synthesis>, because <reasons tied to the critique>.

Rejected: <alternative>, because <reason>.

Remaining risks and how they are caught: <risk> → <test, gate or review check>.

Implementation order: numbered steps `decompose` turns into issues.

### Interfaces

| Interface | Shape | Owner (part) | Used by |
| --- | --- | --- | --- |
| `name` | signature, event or file format | part that defines it | parts that consume it |
```

Child issues created by `decompose` reference the approved design with:

```markdown
## Design excerpt

[<ID> design § Decision](<URL of the approved design comment>)

<the paragraphs and interface rows this issue needs, copied verbatim>
```
