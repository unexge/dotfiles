# Deep-work contract

## Command boundary

The extension registers only `/deep`:

```text
/deep help
/deep config
/deep init [--refresh]
/deep how <question>
/deep design <goal>
/deep review [--base <ref-or-revset>] [intent]
/deep fix <bug report>
/deep build <goal>
/deep verify <claim>
/deep unslop [--base <ref-or-revset>] [text]
/deep status [run-id]
/deep resume <run-id>
/deep cancel [run-id]
/deep recover <run-id> <challenge>
```

Only the registered handler mints `UserOrigin`. No LLM-callable tool, prompt alias, natural-language trigger, or sticky mode can start/control a run. Child sessions load no extensions, prompt templates, discovered skills, themes, or automatic project context.

## Policy and models

Machine policy is strict JSON at `~/.pi/agent/pi-deep-work/config.json`. Trusted repositories may supply strict project policy at `.pi/pi-deep-work.json`; invalid policy is rejected. `/deep init` requires active project trust, resolves the canonical repository root, and deterministically discovers safe checks and behavior mappings from VCS-admitted supported package manifests without executing them. Initial creation never overwrites an existing file. `/deep init --refresh` previews the exact discovered argv and selector patterns, preserves non-`auto.*` entries, writes an immutable backup outside the checkout, and atomically replaces generated entries only after confirmation.

The configured orchestrator owns planning, design, synthesis, verification proposals, and adjudication. The configured work agent owns exploration, implementation, and repair. Every configured review agent must complete design/code review. Each role binds one exact authenticated model and a thinking level supported by that model. Missing, failed, malformed, contradictory, or foreign reviewer output blocks. Orchestrator adjudication is explanatory and cannot clear reviewer severity.

Models never choose argv, observation IDs, claim keys, mappings, subjects, reviewers, or commit authorization. They receive a data-only selector guide containing selector IDs, languages, path patterns, and scopes, and may return only schema-valid selector values from that guide.

## Repository and concurrency

Detection is jj-first, including colocated repositories. Broken `.jj` metadata fails closed. Git CLI is never used for Jujutsu evidence/history/diff/publication; Git-backed ignore admission is not engineering evidence.

One portable run+repository lease serializes every deep run per canonical repository across processes. Different repository IDs may proceed concurrently. Dead leases are reclaimed only after positive owner-death evidence.

No workflow creates branches, worktrees, Jujutsu bookmarks/workspaces, pushes, deployments, remote workers, or package installs.

## Lifecycle authority

The lifecycle is:

```text
Queued -> Active/Pausing -> Paused | Blocked | NeedsManualInspection
       -> Cancelled | Failed | Completed
```

Every resume creates a fresh AttemptId. Recoverable projections persist the exact observed control watermark. Cancel outranks Pause. Checkout safety can supersede a pending control and settle `NeedsManualInspection`; an unconsumed control remains eligible on resume.

`state.json` and append-observable event snapshots are authoritative. Output artifacts are replaceable and explicitly non-authoritative until lifecycle completion.

## Observation and drift

A read-only procedure captures one `ObservationSubject` before model/command/panel evidence, recaptures at boundaries, and discards affected reports on drift. Git subjects bind HEAD/ref/index plus tracked/nonignored working bytes. Jujutsu subjects bind operation/workspace/change/commit/parents and native tree identity.

Ignored-only churn is excluded. The package does not materialize hidden snapshot worktrees.

## Read-only outcomes

- `how`: `ExplanationProduced`
- `unslop`: `UnslopReportProduced`
- `review`: `ReviewApproved` or normal `ChangesRequired`
- `verify`: deterministic `Verified`, `NotVerified`, or `Inconclusive`
- `design`: `DesignApproved` or normal `ChangesRequired`

Standalone verify resolves the exact normalized operator claim to one trusted `VerificationContract` and runs its complete configured observation set. No model command is executed.

## Write preflight and mutation

Before run creation, fix/build require a configured mainline plus at least one applicable quick gate, full gate, behavior observation, and selector. Missing capability fails with an actionable `/deep init --refresh` diagnostic and creates no durable run. Machine gates apply only when their declared languages are active in the project policy. Git then requires the configured active mainline branch, a clean conflict-free tracked/nonignored checkout, and stable matching HEAD/index/tree. Jujutsu requires an empty mutable conflict-free single-parent `@`, stable operation/workspace/change identity, and exact configured mainline bookmark ancestry.

Only implement/repair jobs receive repository-scoped read/search/edit/write tools, never bash. Every completed mutation phase records preimage/result digests and a subject-bound checkpoint. An interrupted or uncheckpointed mutation settles `NeedsManualInspection`; no rollback/reset/clean is attempted.

`fix` requires a coordinator-minted clean red failure from a trusted observation on a sealed regression subject, then the same observation must pass on the final candidate. Passing, timeout, killed, incomplete, drifting, foreign, uncovered, or receipt-less red evidence cannot authorize.

## Qualification and authorization

Both fix/build use:

```text
normalize exactly twice -> seal candidate -> quick gates -> full gates
-> behavior observations -> complete code review panel -> bounded repair
-> deterministic Verified record -> private authorization -> local transaction
```

Every receipt/review/verdict names one exact candidate. A repair seals a new candidate; all old evidence becomes ineligible by subject identity. Only `Verified` can authorize a commit.

## Publication

Git publication uses hook-neutralized `commit-tree`, verifies exact message/tree/identity, and advances the expected ref with compare-and-swap. It never checks out/resets/stages through the user's index; alignment is metadata-only.

Jujutsu publication uses pinned jj-native commands, verifies the exact successor operation and finalized `@-`, and leaves an empty child `@`. Colocated repositories still publish through jj only.

Prepared/publishing/aligning markers are durable and share the controls lock. `/deep status` prints exact run/repository lease states and recovery challenges. Explicit `/deep recover <run-id> <challenge>` records the request before quarantining only positively dead exact owners or the challenged malformed lease, then acquires recovery guards and mechanically reconciles publication independent of current policy.

## Resume and shutdown

Read-only resume reruns against the pinned repository/policy. Write resume requires strict durable workflow context plus immutable approved-design/checkpoint/red-evidence crosschecks and matching live observation. A clean pre-context pause may restart; a dirty pre-context pause becomes `NeedsManualInspection`.

Session shutdown fences new work, appends durable Pause to active or not-yet-registered starts, and waits up to 60 seconds. A timeout emits a visible warning; leases are recoverable by positive death detection.

## Final guarantees

- No model report substitutes for coordinator evidence.
- No non-Verified write path commits.
- No successful workflow pushes.
- Local commits contain one exact reviewed and verified candidate.
