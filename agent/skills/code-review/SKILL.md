---
name: code-review
description: Review staged code for simplicity, unnecessary comments, edge cases, error handling, incomplete implementations, and duplicate or redundant tests. Provides actionable feedback before committing.
---

# Code Review

A skill for reviewing staged code changes to catch common issues before they're committed.

## Workflow

1. **Read all staged changes**
   ```bash
   git diff --cached
   ```
   - If nothing is staged, inform the operator and ask them to stage changes with `git add`
   - Understand the full context of modifications
   - Note file types, additions, deletions, and modifications

2. **Review for simplicity**
   - Code should be as simple as possible and easy to understand
   - Look for:
     - Overly complex logic that could be simplified
     - Deeply nested conditionals or loops
     - Unnecessary abstractions or indirection
     - Long functions that should be broken down
     - Confusing variable or function names
   - Suggest simpler alternatives when complexity is found

3. **Review comments**
   - Comments should only exist when truly necessary
   - Flag for removal:
     - Comments that simply restate what the code does
     - Commented-out code
     - Obvious comments (e.g., `// increment i` for `i++`)
     - TODO comments that should be tickets instead
   - Keep comments that:
     - Explain "why" not "what"
     - Document non-obvious business logic
     - Warn about important edge cases or gotchas

4. **Check for off-by-one errors and edge cases**
   - Carefully examine:
     - Loop boundaries (`<` vs `<=`, `>` vs `>=`)
     - Array/string indexing (0-based vs 1-based)
     - Substring/slice operations (inclusive vs exclusive)
     - Fence post problems in iterations
   - Identify unhandled edge cases:
     - Empty inputs (empty arrays, empty strings, null/undefined)
     - Single element collections
     - Boundary values (0, -1, MAX_INT, etc.)
     - Unicode and special characters in strings

5. **Verify proper error handling**
   - Check for:
     - Uncaught exceptions or missing try/catch blocks
     - Swallowed errors (empty catch blocks)
     - Missing validation of inputs
     - Unhandled promise rejections (async code)
     - Missing null/undefined checks
     - Improper error messages (too vague or exposing internals)
   - Ensure errors are handled at the appropriate level

6. **Detect shortcuts and incomplete implementations**
   - Look for:
     - Hardcoded values that should be configurable
     - Magic numbers without explanation
     - Placeholder code or stub implementations
     - Missing functionality hinted at by comments or names
     - Ignored return values that matter
     - Skipped validation or security checks
   - Ensure all code fully implements its intended purpose

7. **Simplify and deduplicate test cases**
   - Tests should each earn their keep - every test must justify its existence
   - Flag for consolidation or removal:
     - Duplicate tests that assert the same behavior with trivially different inputs
     - Multiple tests covering the same code path without adding new edge cases
     - Copy-pasted tests that differ by only one or two values
     - Overly granular tests that could be combined into a parameterized/table-driven test
   - Flag for simplification:
     - Excessive setup or boilerplate that could be extracted into helpers or fixtures
     - Assertions that test implementation details rather than behavior
     - Tests with unclear names that don't describe what they actually verify
   - Suggest improvements:
     - Merge near-identical tests into parameterized/table-driven tests
     - Replace redundant tests with a single test that covers the same ground
     - Extract shared setup into fixtures or helper functions
     - Ensure each remaining test targets a distinct behavior or edge case

8. **Present findings**
   - Organize feedback by severity:
     - **Critical**: Bugs, security issues, broken functionality
     - **Important**: Edge cases, error handling gaps, incomplete code
     - **Suggestions**: Simplification opportunities, comment cleanup
   - For each issue:
     - Quote the relevant code
     - Explain the problem clearly
     - Suggest a fix when possible
   - If no issues found, confirm the code looks good

9. **Iterate if needed**
   - Offer to re-review after the user makes changes
   - Focus subsequent reviews on modified sections
