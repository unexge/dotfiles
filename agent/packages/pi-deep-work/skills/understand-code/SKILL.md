---
name: understand-code
description: Trace a codebase subsystem from entry point through data and control flow, then explain its ownership, components, and non-obvious constraints with exact source citations. Use for architecture questions and before changing unfamiliar code.
license: MIT
---

# Understand code

Build a working model from source rather than names or summaries.

## Procedure

1. Restate the target as a concrete runtime or ownership question.
2. Locate entry points with repository search and authoritative manifests.
3. Read the central types before tracing behavior.
4. Follow callers and callees through every decision that changes the result.
5. Track the data shape at each boundary and name side effects.
6. Read tests for encoded behavior, but distinguish test setup from production flow.
7. Record exact repository-relative paths and line ranges for every important claim.
8. Stop when the complete path from trigger to observable effect can be explained without hand-waving.

## Output content

- Direct answer and scope
- Key components and ownership
- Ordered runtime or data flow
- Relevant files and symbols
- Non-obvious constraints, contradictions, and gaps

Do not produce annotated source listings. Quote code only when the exact expression is necessary to explain the mechanism.
