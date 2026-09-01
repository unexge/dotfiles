---
name: implement-small-changes
description: Implement the smallest complete code change against an accepted design and explicit verification contract. Use for delegated implementation and repair after review.
license: MIT
---

# Implement small changes

- Change only files required by the goal or accepted review findings.
- Prefer deletion and direct code over new wrappers or configuration.
- Keep validation at external boundaries and trust internal types.
- Preserve one name for each concept.
- Do not add compatibility paths without a real supported caller.
- Keep comments only for constraints the code cannot express.
- Do not weaken tests, types, lint, or error handling to make a gate pass.
- Return exact changed files and an executable verification command.
