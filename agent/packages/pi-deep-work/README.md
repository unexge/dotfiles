# pi-deep-work

`pi-deep-work` runs explicit, high-rigor engineering workflows in the current Git or Jujutsu repository. It uses separate orchestrator, work, and review agents. Successful write workflows create one verified local commit and never push.

Inspired by [pstack](https://github.com/cursor/plugins/tree/main/pstack), it favors a narrow, mechanically enforced local workflow over broad, model-directed playbooks.

## Mental model

- `/deep how` explains the repository without changing it.
- `/deep design` produces, reviews, and renders a design without changing files.
- `/deep build` designs from a goal or approved design, then implements, reviews, verifies, and commits it.
- `/deep fix` proves a regression, fixes it, reviews it, verifies it, and commits it.
- `/deep review` reviews an existing diff without changing it.
- `/deep verify` runs a trusted verification contract without using a model to choose commands.

Only an explicit `/deep ...` command starts or controls a run. There is no sticky deep-work mode.

## Setup

Configure the orchestrator, review panel, and work agent once:

```text
/deep config
```

Initialize each repository where `build` or `fix` may write:

```text
/deep init
```

Review `.pi/pi-deep-work.json`, then keep the checkout clean and on its configured mainline before a write workflow. The policy owns executable commands: `quickGates` run fast checks such as type checking and linting, `fullGates` run complete suites, and `observations` provide behavior evidence. Builds run every configured observation; models never choose commands or selector paths. Fixes derive one trusted observation from the regression files they actually create.

Refresh discovered checks after manifest changes:

```text
/deep init --refresh
```

## Workflows

### Understand before deciding

```text
/deep how Where are upload state and worker lifecycle owned?
/deep how How is cancellation tested?
```

### Iterate on a complex design

```text
/deep design Add resumable uploads with bounded retries
```

A design run creates two candidates, synthesizes one structured design, and sends it to every configured reviewer. Blocker and important findings are revised and reviewed again up to `maxRepairRounds`; only findings that remain after the configured iterations produce `ChangesRequired`. Suggestions do not block approval. The final result includes readable Markdown covering usage, constraints, decisions, data shape, interfaces, modules, invariants, rejected alternatives, tradeoffs, verification, open questions, citations, review findings, and the recommended next command.

The result also prints the absolute path to `outputs/design.md`. The reviewed machine artifact is immutable JSON under `approved-designs/<design-id>/design.json`.

If you want changes, revise the exact prior design with an unambiguous full or partial run ID:

```text
/deep design --from <run-id> Keep persistence in the existing upload repository and remove the scheduler abstraction
```

The revision receives the prior design, prior findings, and your feedback. Its Markdown records that lineage and goes through a fresh complete review.

Build an approved design directly:

```text
/deep build --design <run-id>
```

You may add constraints to the handoff:

```text
/deep build --design <run-id> Reuse the current worker lifecycle and preserve cancellation during backoff
```

The coordinator validates the design run, repository identity, immutable record, artifact digest, and unchanged repository observation. It then creates and reviews a build-specific derivative that preserves accepted decisions and binds every configured behavior observation. If the repository changed since approval, refresh the design with `/deep design --from ...`.

The full machine-readable run summary remains at:

```text
~/.pi/agent/pi-deep-work/runs/<backend>-<repository-id>/<run-id>/artifacts/outputs/design.json
```

Use `/deep status` to find run IDs.

### Build a clear feature directly

```text
/deep build Add bounded retries to the upload worker
```

`build` runs:

```text
frame goal -> design -> design review -> implement -> quick/full gates
-> behavior observations -> exact-candidate code review -> bounded repair
-> deterministic verification -> local commit
```

Build and fix use the same bound for design revisions and exact-candidate code repairs. A successful build commits automatically. There is no human approval pause before the commit. If you need a human design checkpoint, run `/deep design` first.

### Fix a bug

```text
/deep fix Upload cancellation leaves the worker running
```

`fix` requires trusted red evidence for the regression, then requires the same observation to pass on the final candidate before committing.

### Resolve exhausted design findings

```text
/deep resolve <run-id>
/deep resolve <run-id> --accept
```

For a completed `ChangesRequired` design, build, or fix, `resolve` lets you answer the exact remaining findings one at a time or choose `Edit all at once` for the full form. For design runs, `--accept` skips the prompts, records every finding as an accepted limitation, and starts the normal linked design revision; the revised design still requires review approval before it can be built. The source run remains immutable and the new workflow binds the prior summary artifact digest and operator feedback. A mutation-bearing continuation proceeds only when the live checkout and durable source evidence exactly match the recorded checkpoint; otherwise it fails closed.

### Review existing work

```text
/deep review --base main Check the current changes for correctness
/deep unslop --base main
```

Use these for manually written or externally produced changes. A successful `build` or `fix` already includes review of the exact committed candidate.

### Verify a configured claim

```text
/deep verify workspace tests pass
```

The claim must exactly match a verification contract in `.pi/pi-deep-work.json`, apart from ASCII whitespace normalization.

## Runs and recovery

```text
/deep status
/deep status <run-id>
/deep resume <run-id>
/deep resolve <run-id> [--accept]
/deep cancel <run-id>
```

Use `resume` only for paused runs. Use `/deep recover <run-id> <challenge>` only when `status` reports an interrupted publication challenge.

Runs and artifacts are stored outside the checkout under:

```text
~/.pi/agent/pi-deep-work/runs/
```

If mutation or publication cannot be proven safe, the workflow stops for manual inspection. It never resets, cleans, or stashes the checkout.

## Guarantees

- Every configured reviewer must complete design and code review.
- Models never choose executable verification commands.
- Write workflows require trusted quick gates, full gates, and behavior observations.
- Review and verification evidence is bound to one exact candidate.
- Only a deterministic `Verified` result can authorize a local commit.
- No workflow pushes, deploys, installs packages, or creates branches or worktrees.

See [CONTRACT.md](CONTRACT.md) for the full behavioral contract and [docs/test-inventory.md](docs/test-inventory.md) for verification coverage.

## Development

```sh
npm install
npm run check
npm test
```
