---
name: typescript-engineering
description: Design, implement, review, and verify TypeScript changes with runtime boundary parsing, discriminated unions, exhaustive handling, async cleanup, safe package scripts, and behavior-focused tests. Use for package.json, tsconfig, .ts, and .tsx changes.
license: MIT
---

# TypeScript engineering

- Detect the package manager from the repository lock file and use existing scripts.
- Treat external values as `unknown` and parse them once at the boundary.
- Prefer discriminated unions and exhaustive switches over optional-field state bags.
- Avoid `any`, unchecked `as` casts, and lying type guards.
- Derive types from authoritative schemas and existing APIs before declaring duplicates.
- Audit promise rejection, cancellation, resource disposal, and concurrent state updates.
- Keep runtime behavior aligned with static types, especially serialization and optional fields.
- Prefer behavior tests through public interfaces. Avoid broad mock graphs and duplicate cases.
- Run configured format-check, lint, typecheck, and test scripts without installing or changing dependencies.
