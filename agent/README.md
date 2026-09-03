# Agent configuration

`dot sync` installs these files into Pi's global discovery locations using individual symlinks:

- `AGENTS.md` -> `~/.pi/agent/AGENTS.md` and `~/.claude/CLAUDE.md`
- `skills/` -> `~/.pi/agent/skills/`
- `themes/` -> `~/.pi/agent/themes/`
- `settings.json` -> `~/.pi/agent/settings.json`
- `packages/` -> `~/.pi/agent/packages/`
- `bin/` -> `~/.local/bin/`

`packages/pi-deep-work/` is a local Pi package for explicit, high-rigor engineering workflows. Use `/deep config` to select its orchestrator, review agents, optional cheaper work agent, and per-role thinking levels. In each trusted repository that will use write workflows, run `/deep init` to choose the mainline and create the starter project policy, then customize it. The managed global Git ignore keeps `.pi/pi-deep-work.json` machine-local by default; force-add and commit it when a repository should share the trusted policy. Use `/deep help` for all commands. Active runs show the current delegated output above the editor, detailed child output in the display-only transcript, and compact role/task status in the footer. It supports plain Git plus native or colocated Jujutsu, serializes runs per canonical repository, runs trusted gates and complete review panels, resumes from durable checkpoints, creates local commits only after deterministic verification, and never pushes.

Third-party Pi packages are declared in `settings.json`. Third-party Agent Skills packages are declared in `../packages/skills.txt` rather than vendored here.
