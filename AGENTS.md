# Dotfiles Guidelines

- Keep all setup compatible with macOS and Linux.
- Keep `dot sync` idempotent. Repeated runs must be safe.
- Store only generic personal configuration here. Load work and machine-specific configuration through local files outside Git.
- Link individual mutable config files instead of whole application directories.
- Never overwrite an existing user file without backing it up.
- Add system tools to `packages/Brewfile` or the appropriate platform Brewfile.
- Add global npm, Cargo, and third-party skill packages to their manifests under `packages/`.
- Update `README.md` whenever setup behavior or managed tools change.
