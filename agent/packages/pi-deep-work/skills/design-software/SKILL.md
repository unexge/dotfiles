---
name: design-software
description: Design caller usage, data shapes, interfaces, ownership, and module boundaries before implementing a non-trivial change. Use when a change crosses meaningful function or module boundaries or introduces state and concurrency.
license: MIT
---

# Design software

## Procedure

1. Ground the design in actual callers, central types, and current ownership.
2. Write the desired caller usage before internal types.
3. Name the central data shape and who owns each mutable value.
4. Produce at least two structurally different designs for a one-way decision.
5. Compare interface depth, reader load, invalid states, migration cost, and verification.
6. Synthesize one coherent design. Do not average incompatible candidates.
7. Record the base, useful grafts, rejected ideas, and why.
8. Submit the result to independent adversarial review before implementation.

## Red flags

- Optional-field bags that encode implicit states
- One-method pass-through wrappers
- Callers that must know internal sequencing rules
- Shared mutable state added before separation was considered
- Validation repeated inside trusted code
- Compatibility layers without a real migration boundary
- A design whose claimed invariant has no executable check
