---
name: review-software
description: Strictly review an exact code diff against its intent, surrounding architecture, tests, and verification evidence. Use before committing and when asked for adversarial correctness, safety, simplicity, or regression review.
license: MIT
---

# Review software

## Procedure

1. Fix the intended behavior and review scope.
2. Read the complete diff, then relevant callers, callees, types, and tests.
3. Check correctness, security, data integrity, concurrency, cancellation, and error boundaries.
4. Check whether tests exercise the real behavior and would fail on the regression.
5. Check public API, serialization, persistence, protocol, and feature-gate compatibility.
6. Check for unrelated edits, unnecessary abstraction, duplicate tests, narrating comments, and unsupported guards.
7. File only evidenced findings with exact locations and concrete failure modes.
8. File only blockers and important repairs. Omit optional suggestions and minor improvements.
9. Approve only when blocker and important findings are absent or disproved with direct evidence.

Do not modify code. Do not lower severity because tests are green. Do not file preferences already enforced by formatting or lint tools. Do not mention an issue merely to demonstrate review coverage.
