# pi-deep-work

`pi-deep-work` runs explicit, high-rigor engineering workflows in the current Git or Jujutsu repository. GPT 5.6 Sol performs non-review work, and a configured Opus 4.8/5.0 panel reviews designs and code. A write workflow creates a local commit only when trusted evidence verifies the exact reviewed candidate.

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

Select one authenticated GPT 5.6 Sol model and at least one authenticated Opus 4.8 or 5.0 reviewer. Every selected model must support `max` thinking. Configuration is stored at `~/.pi/agent/pi-deep-work/config.json`.

Try a read-only workflow:

```text
/deep how Where is configuration loaded and validated?
/deep review --base main Check the current changes for correctness
/deep unslop --base main
```

Only a command you enter as `/deep ...` can start or control a run. There is no automatic or sticky mode.

## Commands

| Command | Result |
|---|---|
| `/deep help` | Show command syntax. |
| `/deep config` | Select the writer and review panel. |
| `/deep how <question>` | Explain the current repository from cited source evidence. |
| `/deep design <goal>` | Produce an Opus-reviewed design without modifying files. |
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

`how`, `design`, `review`, and `unslop` work after model setup. `fix` and `build` also require a trusted, committed `.pi/pi-deep-work.json` containing:

- the exact Git branch or Jujutsu bookmark used as `mainline`;
- trusted behavior observations and selectors;
- any additional gates, normalizers, or language scopes.

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

The generated machine policy starts with Cargo check and test as mandatory minimum gates. For a non-Rust repository, replace `minimumQuickGates` and `minimumFullGates` in `~/.pi/agent/pi-deep-work/config.json` with trusted argv for that environment, then adapt the project policy's observation and selector language.

Policy is strict JSON. Unknown fields, missing required fields, duplicate IDs, unsafe paths, invalid references, and commands exceeding the machine timeout are rejected. Models may select only configured observations; they never choose executable argv.

## Write requirements

`fix` and `build` modify the active checkout directly. Before mutation:

- Git must be clean, conflict-free, on the configured mainline branch, with matching HEAD, index, and working tree.
- Jujutsu must have an empty, mutable, conflict-free, single-parent `@` descended from the configured exact mainline bookmark.

The workflow then requires an approved design, trusted quick and full gates, behavior evidence, complete Opus code review, a deterministic `Verified` verdict, and an unchanged candidate hash. It creates one local commit and never pushes. If review or verification does not pass, the candidate remains uncommitted for inspection.

Only implementation and repair agents receive repository-scoped edit tools. Delegated agents never receive bash. One lease serializes runs per repository, while different repositories may run concurrently.

## State and recovery

Durable runs are stored under:

```text
~/.pi/agent/pi-deep-work/runs/<backend>-<repository-id>/<run-id>/
```

Use `/deep status` to inspect lifecycle, outcome, repository identity, live observation, leases, and recovery challenges. Use `resume` for a valid paused checkpoint. Use `recover` only for interrupted publication when `status` supplies a challenge. Unsafe or ambiguous dirty state stops at `NeedsManualInspection`; the extension does not reset, clean, or stash it.

See [CONTRACT.md](CONTRACT.md) for the complete behavioral contract and [docs/test-inventory.md](docs/test-inventory.md) for implemented verification coverage.

## Development

```sh
npm install
npm run check
npm test
```

The package supports Rust, Zig, Python, and TypeScript repositories. It has no third-party runtime dependencies; Pi supplies its peer packages.
