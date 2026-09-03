# pi-deep-work

`pi-deep-work` runs explicit, high-rigor engineering workflows in the current Git or Jujutsu repository. A configured orchestrator directs each workflow, an independently configured work agent handles exploration and repository changes, and a complete review panel checks designs and code. A write workflow creates a local commit only when trusted evidence verifies the exact reviewed candidate.

Inspired by [pstack](https://github.com/cursor/plugins/tree/main/pstack), it trades pstack's broad, model-directed parallel playbooks for a narrow, mechanically enforced local workflow that commits only verified candidates.

## Quick start

The package is already enabled by this dotfiles repository. Run `dot sync` after initial setup or `dot link` after changing package paths.

Start Pi in the repository you want to work on:

```sh
cd /path/to/repository
pi
```

Configure models once from inside Pi:

```text
/deep config
```

Select authenticated models and supported thinking levels for three roles:

- **Orchestrator**: planning, design, synthesis, verification proposals, and adjudication. GPT 5.6 Sol at `max` or `xhigh` is recommended.
- **Review agents**: every selected agent reviews each design and code candidate. Opus 5.0 or 4.8 at `max` or `xhigh` is recommended.
- **Work agent**: exploration, implementation, and repair. Reusing the orchestrator model at `high` is the default; choose a cheaper model when desired.

Recommendations affect picker order only. Any authenticated model may fill any role, and `/deep config` offers only thinking levels supported by that model. Configuration is stored at `~/.pi/agent/pi-deep-work/config.json`. Existing schema-version 1 configuration remains readable; running `/deep config` writes the role-based schema.

Initialize each trusted repository where `build` or `fix` should write:

```text
/deep init
```

`/deep init` prompts for the Git branch or Jujutsu bookmark used as mainline, with `main` as the default. It scans supported root and nested package manifests without running their commands, previews safe checks and behavior observations, and writes them as deterministic `auto.*` entries in `.pi/pi-deep-work.json`. It never overwrites an existing policy. Use `/deep init --refresh` to replace generated entries after confirmation while preserving custom entries and backing up the previous file under `~/.pi/agent/pi-deep-work/policy-backups/`, outside the checkout.

Try a read-only workflow:

```text
/deep how Where is configuration loaded and validated?
/deep review --base main Check the current changes for correctness
/deep unslop --base main
```

Only a command you enter as `/deep ...` can start or control a run. There is no automatic or sticky mode.

While a run is active, the current delegated-agent output appears in a live widget and the footer identifies the active role and task. Finalized assistant messages, tool calls, and complete textual tool results remain in the Pi transcript as display-only entries; they are not added to the parent model's context. Delegated sessions remain contract-driven and cannot be steered from the editor.

## Commands

| Command | Result |
|---|---|
| `/deep help` | Show command syntax. |
| `/deep config` | Select the orchestrator, review panel, work agent, and thinking levels. |
| `/deep init [--refresh]` | Discover safe repository checks and create or refresh the project policy. |
| `/deep how <question>` | Explain the current repository from cited source evidence. |
| `/deep design <goal>` | Produce a review-panel-approved design without modifying files. |
| `/deep review [--base <ref-or-revset>] [intent]` | Review the current backend-native diff without modifying files. |
| `/deep fix <bug report>` | Reproduce the bug, prove red-to-green behavior, and create a verified local commit. |
| `/deep build <goal>` | Design, implement, review, verify, and create a local commit. |
| `/deep verify <claim>` | Run the trusted verification contract for the exact configured claim. |
| `/deep unslop [--base <ref-or-revset>] [text]` | Report unnecessary code or prose without modifying files. Text and `--base` are mutually exclusive. |
| `/deep status [run-id]` | Show recent repository runs or one full/unambiguous partial run ID. |
| `/deep resume <run-id>` | Resume a paused run from durable state. |
| `/deep cancel [run-id]` | Cancel the only active run, or the specified run. |
| `/deep recover <run-id> <challenge>` | Recover an interrupted transaction using a challenge printed by `status`. |

Useful examples:

```text
/deep design Add bounded retries to the upload worker
/deep build Add bounded retries to the upload worker
/deep fix Upload cancellation leaves the worker running
/deep verify workspace tests pass
/deep status
```

## Repository policy

`how`, `design`, `review`, and `unslop` work after model setup. `fix` and `build` also require a trusted `.pi/pi-deep-work.json` containing:

- the exact Git branch or Jujutsu bookmark used as `mainline`;
- at least one applicable quick gate and full gate;
- trusted behavior observations and selectors.

Run `/deep init` to discover supported Rust, Zig, Python, and TypeScript packages and create a strict policy. Discovery reads only VCS-admitted manifests and lock files, never executes package commands, and rejects installing, mutating, lifecycle-hooked, or unknown TypeScript scripts. If no safe behavior test is found, write workflows fail before creating a durable run and direct you to `/deep init --refresh`. Generated entries use reserved `auto.*` IDs; custom entries are preserved across refreshes.

`verify` requires a verification contract whose `claim` matches the command's claim exactly, apart from surrounding or repeated ASCII whitespace.

Minimal Rust example:

```json
{
  "schemaVersion": 1,
  "mainline": "main",
  "quickGates": [],
  "fullGates": [],
  "normalizers": [],
  "observations": [
    {
      "id": "workspace-tests",
      "claimKeys": ["workspace.tests"],
      "argv": ["cargo", "test", "--workspace", "--locked"],
      "timeoutMs": 1200000
    }
  ],
  "verificationContracts": [
    {
      "id": "workspace-tests-pass",
      "claim": "workspace tests pass",
      "requiredClaimKeys": ["workspace.tests"],
      "observationIds": ["workspace-tests"]
    }
  ],
  "selectors": [
    {
      "id": "rust-source",
      "language": "rust",
      "observationId": "workspace-tests",
      "valuePattern": ".+\\.rs"
    }
  ],
  "languageScopes": []
}
```

The generated machine policy contains language-scoped Cargo minimum gates. They run only when the project policy activates Rust; discovered project gates handle supported non-Rust repositories. Machine gates remain an optional additional policy floor for their declared languages.

Policy is strict JSON. Unknown fields, missing required fields, duplicate IDs, unsafe paths, invalid references, and commands exceeding the machine timeout are rejected. Models may select only configured observations; they never choose executable argv.

## Write requirements

`fix` and `build` modify the active checkout directly. Before mutation:

- Git must be clean, conflict-free, on the configured mainline branch, with matching HEAD, index, and working tree.
- Jujutsu must have an empty, mutable, conflict-free, single-parent `@` descended from the configured exact mainline bookmark.

The workflow then requires an approved design, trusted quick and full gates, behavior evidence, complete code review, a deterministic `Verified` verdict, and an unchanged candidate hash. It creates one local commit and never pushes. If review or verification does not pass, the candidate remains uncommitted for inspection.

Only implementation and repair jobs receive repository-scoped edit tools. Delegated agents never receive bash. One lease serializes runs per repository, while different repositories may run concurrently.

## State and recovery

Durable runs are stored under:

```text
~/.pi/agent/pi-deep-work/runs/<backend>-<repository-id>/<run-id>/
```

Use `/deep status` to inspect lifecycle, outcome, repository identity, live observation, leases, and recovery challenges. Use `resume` for a valid paused checkpoint. Use `recover` only for interrupted publication when `status` supplies a challenge. Unsafe or ambiguous dirty state stops at `NeedsManualInspection`; the extension does not reset, clean, or stash it. Changing the project policy, including `/deep init --refresh`, changes its digest and requires a new run.

See [CONTRACT.md](CONTRACT.md) for the complete behavioral contract and [docs/test-inventory.md](docs/test-inventory.md) for implemented verification coverage.

## Development

```sh
npm install
npm run check
npm test
```

The package supports Rust, Zig, Python, and TypeScript repositories. It has no third-party runtime dependencies; Pi supplies its peer packages.
