# Agent configuration

`dot sync` installs these files into Pi's global discovery locations using individual symlinks:

- `AGENTS.md` -> `~/.pi/agent/AGENTS.md` and `~/.claude/CLAUDE.md`
- `skills/` -> `~/.pi/agent/skills/`
- `themes/` -> `~/.pi/agent/themes/`
- `settings.json` -> `~/.pi/agent/settings.json`
- `packages/` -> `~/.pi/agent/packages/`
- `bin/` -> `~/.local/bin/`

`packages/pi-deep-work/` is a local Pi package for explicit, high-rigor engineering workflows. Configure its required GPT 5.6 Sol and Opus 4.8/5.0 models with `/deep config`, then use `/deep help` for commands. supports plain Git plus native or colocated Jujutsu, serializes runs per canonical repository, runs trusted gates and complete Opus review, resumes from durable checkpoints, creates local commits only after deterministic verification, and never pushes.

Third-party Pi packages are declared in `settings.json`. Third-party Agent Skills packages are declared in `../packages/skills.txt` rather than vendored here.
