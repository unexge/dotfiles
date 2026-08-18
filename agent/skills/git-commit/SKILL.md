---
name: git-commit
description: Create well-crafted commit messages following project conventions, in Git or Jujutsu (jj) repositories. Detects the VCS, analyzes the changes to commit, detects commit patterns, and proposes concise messages for approval.
---

# Commit

A skill for creating thoughtful commit messages that follow your project's conventions, for both Git and Jujutsu (jj) repositories.

## Workflow

1. **Detect the version control system**
   ```bash
   jj root --ignore-working-copy
   ```
   - If this succeeds, treat the repo as jj and use the jj commands below
   - Colocated repos contain both `.jj` and `.git`; jj still wins
   - Otherwise treat the repo as Git

2. **Collect the changes to commit**
   - **Git**: ask the user to stage the changes they want to commit using `git add`, wait for confirmation, then read them:
     ```bash
     git diff --cached
     ```
   - **jj**: there is no staging area, the working copy is already a commit (`@`), so read everything in it:
     ```bash
     jj status
     jj diff --git
     ```
     - If only part of the working copy belongs in this commit, ask the user which paths to include (pass them to `jj commit` in step 5) or ask them to run `jj split` first
   - Understand what files changed and the nature of modifications
   - Note additions, deletions, and modifications

3. **Analyze recent commit history for patterns**
   - **Git**:
     ```bash
     git log --oneline -20
     ```
   - **jj**:
     ```bash
     jj log -r '::@' -n 20 --no-graph --ignore-working-copy -T 'description.first_line() ++ "\n"'
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
     - **Git**:
       ```bash
       git commit -m "header" -m "body"
       ```
     - **jj** (repeated `-m` flags are joined with a blank line, like Git):
       ```bash
       jj commit -m "header" -m "body"
       ```
       - To include only selected paths: `jj commit -m "header" path/one path/two`
       - To only reword an existing change instead of finishing the working copy: `jj describe -r <rev> -m "header" -m "body"`
