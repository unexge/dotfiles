# Agent configuration

`dot sync` installs these files into Pi's global discovery locations using individual symlinks:

- `AGENTS.md` -> `~/.pi/agent/AGENTS.md` and `~/.claude/CLAUDE.md`
- `skills/` -> `~/.pi/agent/skills/`
- `themes/` -> `~/.pi/agent/themes/`
- `settings.json` -> `~/.pi/agent/settings.json`
- `bin/` -> `~/.local/bin/`

Third-party Pi packages are declared in `settings.json`. Third-party Agent Skills packages are declared in `../packages/skills.txt` rather than vendored here.
