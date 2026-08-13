---
name: git-commit
description: Create well-crafted git commit messages following project conventions. Analyzes staged changes, detects commit patterns, and proposes concise messages for approval.
---

# Git Commit

A skill for creating thoughtful git commit messages that follow your project's conventions.

## Workflow

1. **Ask the operator to stage changes**
   - Prompt the user to stage the changes they want to commit using `git add`
   - Wait for confirmation before proceeding

2. **Read all staged changes**
   ```bash
   git diff --cached
   ```
   - Understand what files changed and the nature of modifications
   - Note additions, deletions, and modifications

3. **Analyze recent commit history for patterns**
   ```bash
   git log --oneline -20
   ```
   - Look for commit message conventions (e.g., conventional commits like `feat:`, `fix:`, `docs:`)
   - Identify any prefixes, formatting patterns, or issue/ticket references
   - Match the existing style of the repository

4. **Craft the commit message**
   - **Header**: Super concise summary (50 chars or less ideally)
     - Follow detected convention (e.g., `feat: add user auth` or `[ARTEMIS-9635] Fix login bug`)
     - Use imperative mood ("Add feature" not "Added feature")
     - Make sure to backtick ("`") any references to files, functions and similar things (e.g., "style: add missing doc comments to `reload_config`")
   - **Body** (if needed): Brief explanation of what and why
     - Add only when changes are complex or non-obvious
     - Wrap at 72 characters

5. **Present and confirm**
   - Share the proposed commit message with the operator
   - Wait for explicit approval before committing
   - Execute the commit only after approval:
     ```bash
     git commit -m "header" -m "body"
     ```
