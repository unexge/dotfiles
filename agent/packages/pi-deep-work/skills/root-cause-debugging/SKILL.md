---
name: root-cause-debugging
description: Reproduce a defect, trace its causal chain to the owning invariant, add an executable regression check, and fix the root cause. Use for bug reports, crashes, wrong behavior, races, leaks, and regressions.
license: MIT
---

# Root-cause debugging

1. State expected and observed behavior.
2. Find the narrowest executable reproduction.
3. Trace from the symptom through each state transition to the violated invariant.
4. Cite the production path and distinguish cause from nearby damage.
5. Design the smallest repair at the owning boundary.
6. Add a regression check that fails for the intended reason before fixing production code.
7. Apply the fix, rerun the regression, then run surrounding gates.
8. Search sibling paths only when the same causal shape can occur there.

Do not silence a crash with a guard unless absence is a valid domain state. Do not call a test a reproduction until its pre-fix failure is captured.
