---
name: autoresearch-rust-review
description: Drive a pi-autoresearch session whose metric is the `rust-review-complexity` score. Use to make a Rust change easier to review by iteratively refactoring against the branch's merge-base with mainline.
---

# Autoresearch: minimise Rust review complexity

Glue between two existing skills. Supplies `autoresearch-create` with
the right answers to its setup questions, then lets `pi-autoresearch`
run the loop.

## Workflow

1. **Resolve the baseline SHA and scorer path:**
   ```bash
   if git rev-parse --verify --quiet origin/mainline >/dev/null; then
       MAINLINE=origin/mainline
   else
       MAINLINE=origin/main
   fi
   BASE="$(git merge-base HEAD "$MAINLINE")"
   SCORER="$HOME/.pi/agent/skills/rust-review-complexity/scripts/complexity_delta.py"
   test -x "$SCORER"
   ```
   Both values are pinned for the whole session - the merge-base does
   not move because autoresearch commits only on a side branch.

2. **Invoke `/skill:autoresearch-create`** and supply these answers
   verbatim. `autoresearch-create` writes `autoresearch.md`,
   `autoresearch.sh`, `autoresearch.checks.sh`, runs the baseline, and
   starts the loop.

   - **Goal:**
     > Make the current change easier to review without changing
     > behaviour. Constraints: no public API / return type / error /
     > side-effect changes; only edit functions whose status is `added`
     > or `modified` in `autoresearch.last_report.json`; never lower the
     > score by deleting tests, weakening error handling, or hiding
     > complexity behind macros the metric cannot see; if a refactor
     > lowers the score but reads worse, revert it.

   - **Command** (paste with `$BASE` and `$SCORER` substituted to
     literal values so the loop has no environmental dependencies):
     ```bash
     "$SCORER" --base "$BASE" --json \
       | tee autoresearch.last_report.json \
       | jq -r '"METRIC review_score=\(.total_score)"'
     ```

   - **Metric:** `review_score`, unit `points`, direction `lower`.
   - **Files in scope:** files appearing in `git diff $BASE`.
   - **Backpressure:** suggest
     `cargo check && cargo clippy --all-targets -- -D warnings && cargo test`.

The loop now drives. Dashboard, stop conditions, and
`/skill:autoresearch-finalize` are owned by `pi-autoresearch`.

## Notes

- `autoresearch.last_report.json` is written by the benchmark on every
  run; the agent reads it between iterations to pick refactor targets
  without re-invoking the scorer.
- Weight tuning lives in `complexity_delta.py`, not here.
