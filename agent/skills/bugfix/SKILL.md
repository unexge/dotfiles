---
name: bugfix
description: Fix a bug by understanding it, writing failing tests, verifying with operator, fixing with passing tests, analyzing blast radius, and suggesting prevention strategies.
---

# Bugfix

A skill for systematically fixing bugs with proper verification, testing, and prevention analysis.

## Workflow

1. **Understand the bug**
   - Gather all available information about the bug:
     - Error messages, stack traces, logs
     - Steps to reproduce
     - Expected vs actual behavior
     - When it started occurring (if known)
   - Ask clarifying questions if the bug description is incomplete
   - Identify the affected code area(s)
   - Read relevant source files to understand the context

2. **Write a failing test case**
   - Create a test that reproduces the bug
   - The test should:
     - Clearly demonstrate the failure
     - Be minimal and focused on the specific bug
     - Include descriptive test name explaining the scenario
   - Run the test to confirm it fails:
     ```bash
     # Use project's test runner (detect from package.json, Makefile, etc.)
     ```
   - If the test passes unexpectedly, revisit understanding of the bug

3. **Identify similar potential failures**
   - Think about related edge cases and scenarios:
     - Are there similar code paths that might have the same issue?
     - Could this bug occur with different inputs or conditions?
     - Are there other places in the codebase with similar patterns?
   - List potential similar failures for the operator to consider
   - Propose additional test cases if warranted

4. **Verify with operator**
   - Present your understanding of the bug:
     - Root cause analysis
     - The failing test case(s)
     - Similar potential failures identified
     - Proposed fix approach
   - **Wait for explicit operator confirmation before proceeding**
   - Incorporate any feedback or corrections from the operator

5. **Implement the fix**
   - Make the minimal necessary changes to fix the bug
   - Follow existing code patterns and style
   - Avoid introducing new complexity
   - Consider backward compatibility if applicable
   - Run all tests to ensure:
     - The new failing test now passes
     - No existing tests are broken
     ```bash
     # Run full test suite
     ```
   - If tests fail, iterate until all pass

6. **Analyze blast radius**
   - Investigate the scope and impact of the bug:
     - **Conditions**: Under what specific conditions does this problem occur?
       - Input types, data shapes, edge cases
       - Environment conditions (config, timing, concurrency)
       - User actions or sequences that trigger it
     - **Affected areas**: What parts of the system are impacted?
       - Direct functionality affected
       - Downstream dependencies
       - Data integrity implications
     - **User impact**: Who is affected and how severely?
       - Frequency of occurrence
       - Workarounds available (if any)
       - Data loss or corruption potential
   - Summarize the blast radius assessment for the operator

7. **Suggest prevention strategies**
   - Reflect on how this bug occurred and propose preventive measures:
     - **Code-level improvements**:
       - Type safety enhancements
       - Validation/assertion additions
       - Better error handling
       - Defensive programming patterns
     - **Testing improvements**:
       - Additional test coverage areas
       - Property-based testing opportunities
       - Integration/E2E test additions
     - **Process improvements**:
       - Code review checklist additions
       - Documentation updates
       - Linting rules or static analysis
     - **Architectural considerations**:
       - Design patterns to prevent similar issues
       - Abstraction improvements
       - Separation of concerns
   - Present prevention recommendations to the operator

8. **Summary and closure**
   - Provide a concise summary:
     - What the bug was
     - How it was fixed
     - Tests added
     - Blast radius assessment
     - Prevention recommendations
   - Offer to assist with:
     - Creating follow-up tickets for prevention improvements
     - Documenting the fix for team knowledge sharing
     - Reviewing the fix with `code-review` skill before committing
