# Implemented test inventory

The package has one installed execution graph. All package tests live under `tests/`.

## Command and capability boundary

- One registered `/deep` command with strict grammar and completion, including linked design revision and approved-design build handoff.
- No `registerTool`, manifest prompt, natural-language trigger, or child-session extension loading.
- Unforgeable `UserOrigin` required for start/resume/cancel/recover.
- Per-run UI keys, durable controls, shutdown fencing, and timeout warning.
- Full/unambiguous IDs; status-issued lease recovery challenges; audited dead/malformed lease recovery; malformed runs isolated.

## Policy and agents

- Strict machine/project TypeBox schemas, unknown-key rejection, canonical digest, project trust boundary.
- Canonical-root project policy initialization with prompted mainline, nested supported-package discovery, safe-script rejection, deterministic gates/observations/selectors/contracts, confirmation, and no overwrite of existing policy.
- Explicit refresh preserves custom entries, replaces reserved `auto.*` entries, creates a backup, and writes atomically.
- Exact authenticated orchestrator, work, and complete reviewer bindings with model-supported thinking levels; legacy model policy migration.
- Fixed role/model/tool map; only implement/repair receive repository mutation tools; no model bash.
- Structured report decoding, isolated child resources, bounded concurrency, model cancellation.
- Data-only selector mapping to package/catalog-owned commands and redacted selector guidance that exposes no argv or observation mapping.

## Repository and subjects

Real fixtures cover:

1. Plain Git.
2. Native non-colocated Jujutsu.
3. Colocated Jujutsu, selected before Git.

Coverage includes repository identity, broken metadata, tracked/untracked/staged/deleted/binary/symlink/mode/submodule bytes, ignored churn, conflicts, Git index/HEAD/ref, jj snapshot/operation/workspace/change/commit/parents/tree, observed diffs, explicit Git bases and jj revsets, and drift invalidation.

## Leases, lifecycle, and store

- Cross-process portable run/repository leases, linked Git/jj exclusion, positive-death reclaim, malformed/live ambiguity, and recovery guards.
- Closed lifecycle transitions, control watermark persistence, Pause/Cancel ordering, manual-inspection precedence, fresh AttemptId resume, and exact lease release.
- Atomic events/state/checkpoints/controls/artifacts/publication markers, ambiguous lookup, malformed-run isolation.
- Mutation crash tests leave bytes for operator inspection and project `NeedsManualInspection`.

## Evidence and review

- Trusted quick/full/observation catalogs, project-language filtering of machine gates, write-readiness preflight, and supervised process-group timeout/cancel/output handling.
- Same-subject immutable gate records and receipts; foreign command/backend/subject/claim rejection.
- Exactly two normalizer passes and fixed-point candidate sealing.
- Complete design/code review panels, canonical findings, fresh-subject replay, explanatory-only orchestrator adjudication.
- Deterministic behavior verdict precedence and exact standalone contract lookup.
- Branded clean red evidence, timeout/pass/drift rejection, candidate-bound green receipt, and red-path containment.

## Publication

Git tests cover hook-neutralized temporary-index tree construction, `commit-tree`, expected-old `update-ref`, metadata-only `read-tree` alignment, cancellation ordering, ref/index/worktree topology, and markerless/pre/post-CAS recovery.

Jujutsu tests cover pinned 0.41 native commands, operation linearization, complete-`@` commit, finalized `@-`, empty child `@`, bookmark/workspace/source invariants, cancellation ordering, and markerless/pre/post-operation/alignment/divergent recovery. Colocated publication invokes no Git evidence/publication command.

Neither backend pushes.

## Workflows and runtime

- `how`, text/diff `unslop`, `review`, standalone `verify`, and standalone `design` positive/negative/drift/control outcomes.
- Deterministic design Markdown, structured constraints/decisions/alternatives, complete review findings, same-repository revision lineage, and digest-validated approved-design handoff.
- Build derivatives bind source design identity and reject changed repository observations before implementation.
- Git/jj `beginWrite`; dirty/conflict/merge/immutable/mainline ancestry rejection.
- Mutation-owned build/fix implementation and repair checkpoints.
- Real Git/native-jj/colocated-jj build commits and fix red-to-green commits.
- Real non-Verified build remains uncommitted; already-green/timeout/drifting red proof blocks.
- Read-only resume, clean no-context write restart, dirty no-context manual inspection, build/fix checkpoint resume, fix red-stage resume, context/checkpoint tamper rejection, and transaction recovery.
- Installed runtime metadata, all seven dispatch paths, status, controls, shutdown races, and single-graph entrypoint.

Release verification requires Jujutsu tests to run, not skip. Permanent boundary tests verify the single installed runtime graph and command capability surface.
