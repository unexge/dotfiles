---
name: rust-review-complexity
description: Quantify how hard a Rust change is to review by diffing per-function cognitive/cyclomatic complexity and SLOC against a git baseline. Use to drive an agent loop that minimises review difficulty before submitting a change.
---

# Rust Review Complexity

A skill for measuring how hard a set of Rust changes is to review, by comparing
per-function metrics in the working tree against a git baseline. Designed for
two flows:

1. **One-shot scoring** - show the operator where review effort is concentrated.
2. **Agent loop** - repeatedly run the scorer in JSON mode, refactor toward a
   lower score, and iterate until the change is comfortable to review.

## Dependencies

- `rust-code-analysis-cli` - Mozilla's polyglot metrics tool, used for
  per-function cognitive/cyclomatic complexity and SLOC.
  ```bash
  cargo install rust-code-analysis-cli
  ```
- `git` - to enumerate changed files and extract baseline versions.
- `uv` - runs the scoring script as a self-contained PEP 723 script
  (`uv run` is invoked via the script's shebang). Install from
  <https://docs.astral.sh/uv/>.

Optional supplements (the operator can interpret these alongside the score):
- `cargo clippy --message-format=json` with `cognitive_complexity` threshold
  lowered in `clippy.toml`.
- `cargo geiger` - `unsafe` block delta is a strong "needs careful review"
  signal.

## Score model

For every function present in the baseline and/or current tree:

```
fn_score = 2·|Δcognitive| + 1·|Δcyclomatic| + 0.1·|Δnloc|
```

Per-file structural penalties:
- `+5` if the file is new (no baseline context for the reviewer)
- `+2` if the file is deleted

Whole-change penalty:
- `+1.5` per changed file beyond the first (cross-file edits are harder to
  hold in your head than a single-file edit of equal LOC)

Total score is the sum. The weights are tunable - see `scripts/complexity_delta.py`.

> Cognitive complexity is weighted higher than cyclomatic because it tracks
> how hard code is to *read* (nesting, breaks in linear flow), not just how
> many independent paths exist.

## Workflow

1. **Verify dependencies**
   ```bash
   command -v rust-code-analysis-cli || echo "missing: cargo install rust-code-analysis-cli"
   ```
   If missing, stop and ask the operator to install it.

2. **Pick a baseline ref**
   - Default: `HEAD` (compares working tree + staged + unstaged against the
     last commit).
   - For a feature branch under review: the merge-base with `mainline`/`main`,
     e.g. `git merge-base HEAD origin/mainline`.
   - Confirm the baseline with the operator if unclear.

3. **Run the scorer (human mode)**
   ```bash
   "$HOME/.pi/agent/skills/rust-review-complexity/scripts/complexity_delta.py" --base <ref>
   ```
   Output ranks files by score and lists the top contributing functions per
   file with `status`, Δcognitive, Δcyclomatic, Δnloc, and per-function score.

4. **Interpret the result**
   - **Score 0-10**: trivial review.
   - **10-30**: ordinary change, no special handling.
   - **30-80**: dense - flag the highest-scoring functions to the reviewer.
   - **>80**: consider splitting the PR or refactoring before review.
   - These bands are heuristic; calibrate against past PRs in your repo.

5. **Identify reduction opportunities**
   For the top functions, look for:
   - Deeply nested `match`/`if let` chains that could become early returns or
     `let ... else`.
   - Long functions that combine orthogonal concerns - extract helpers.
   - Combinator chains that hide branching - sometimes a plain loop reads
     better and lowers cognitive complexity even if cyclomatic is unchanged.
   - New functions that duplicate existing logic - reuse instead.
   - Cross-cutting edits that could be staged as a separate prep commit.

6. **Agent loop (optional)**
   When invoked to *minimise* review complexity automatically:
   ```bash
   "$HOME/.pi/agent/skills/rust-review-complexity/scripts/complexity_delta.py" \
       --base <ref> --json
   ```
   - Parse `total_score` and the per-function breakdown.
   - Pick the highest-`score` function and propose a refactor that preserves
     behaviour. Run `cargo check` (and the project's test command) after each
     edit.
   - Re-run the scorer. Accept the change only if `total_score` decreased and
     tests still pass.
   - Stop when the score is below the operator's target, when no further
     reduction is found after N attempts, or when the operator says stop.

   Guardrails for the loop:
   - **Never** lower the score by deleting tests, removing error handling, or
     hiding complexity behind macros that defeat the metric.
   - **Never** rewrite code the operator did not author in this change - only
     touch functions whose `status` is `added` or `modified`.
   - Prefer reductions that also improve readability subjectively; if a
     refactor lowers the score but reads worse, revert it.

7. **Present findings**
   - Lead with the total score and the bucket it falls in.
   - List the top 3-5 functions by score with a one-line suggestion each.
   - If the loop ran, summarise the score before/after and the refactors made.

## Notes and caveats

- `rust-code-analysis` does not expand macros; macro-heavy code may be
  under- or over-counted. Treat the score as a signal, not a verdict.
- Generated files (`build.rs` outputs, `prost`/`tonic` modules) can dominate
  the score - exclude them with a `.gitattributes`-style filter or a wrapper
  script if needed.
- The score is a *relative* tool: the same change scored against `HEAD~1` vs.
  `origin/mainline` can differ wildly. Always state the baseline.
