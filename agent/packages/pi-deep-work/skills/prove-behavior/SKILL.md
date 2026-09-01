---
name: prove-behavior
description: Convert a completion claim into a falsifiable predicate and return VERIFIED, NOT_VERIFIED, INCONCLUSIVE, or BLOCKED from direct evidence. Use before declaring code or behavior complete.
license: MIT
---

# Prove behavior

1. State the predicate in observable terms.
2. Capture the relevant before state or pre-fix failure.
3. Exercise the real changed path.
4. Capture the resulting state and side effects.
5. Distinguish compilation, static checks, unit tests, integration behavior, and live behavior.
6. Check that evidence belongs to the reviewed candidate.
7. Return one verdict and explicit limitations.

A passing proxy does not prove a stronger claim. Agent self-report is not evidence.
