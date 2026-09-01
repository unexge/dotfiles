---
name: unslop-code
description: Find and remove unsupported AI-generated code patterns such as narrating comments, speculative guards, dead compatibility paths, needless wrappers, scope creep, and duplicate tests. Use when auditing a diff for maintainability before review.
license: MIT
---

# Unslop code

Inspect the exact diff and surrounding code. Report only patterns supported by evidence.

- Remove comments that narrate the next statement or obsolete change history.
- Keep comments for external constraints code cannot express.
- Reject guards that hide an invariant violation or impossible internal state.
- Reject compatibility paths without a supported caller or migration boundary.
- Collapse one-caller pass-through wrappers when they add no boundary or invariant.
- Remove unrelated edits and speculative configuration.
- Consolidate tests that prove the same behavior; keep distinct boundary cases.
- Do not trade direct code for a new abstraction merely to make the diff look designed.
- Do not weaken types, tests, errors, lint, or validation.

For each issue, cite the exact location, explain the concrete reader or correctness cost, and state the smallest correction.
