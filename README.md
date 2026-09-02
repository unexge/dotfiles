# dotfiles

Personal development environment for macOS laptops and Linux remote machines. Configuration lives in this repository and is installed with individual symlinks.

## Install

The machine must have `git`, `curl`, and Bash. On Linux, Homebrew may also require native build prerequisites and `sudo` during its initial installation.

```sh
git clone https://github.com/unexge/dotfiles.git ~/.dotfiles
~/.dotfiles/bootstrap.sh
```

`bootstrap.sh` runs the first synchronization, which links `dot` into `~/.local/bin`. It is safe to run again.

Nushell adds `~/.local/bin` to `PATH`. Until the shell configuration has reloaded, invoke the command as `~/.local/bin/dot`.

## Update

```sh
dot sync
```

`dot sync` performs these steps:

1. Pull the current branch with `git pull --ff-only` when it has an upstream.
2. Create or repair managed configuration links.
3. Install Homebrew when missing.
4. Upgrade packages declared in the Brewfiles and rebuild Bat's theme cache.
5. Update Rust and install declared Cargo binaries.
6. Install or update declared global npm packages and Agent Skills.
7. Update Pi packages declared in `agent/settings.json`.
8. Run installation health checks.

Other commands are available for focused operations:

```sh
dot apply      # Everything except git pull
dot link       # Repair links only
dot packages   # Update dependencies only
dot doctor     # Verify the installation
dot help
```

## Managed configuration

- Emacs
- Git ignore and the shared Bat/Delta theme
- Ghostty (macOS)
- Helix
- Hunk extensions
- Nushell
- Zellij
- `magit` terminal launcher
- Pi instructions, settings, skills, themes, and the local `pi-deep-work` package
- Agent workflow commands under `agent/bin/`

Only files tracked in this repository are linked, and links pointing at files the repository no longer contains are removed on the next `dot link`. Existing target files are moved to timestamped `.bak.*` paths before links are created. Mutable application directories are not linked wholesale, so history, caches, and local state remain outside the repository.

## Dependencies

System and command-line packages are declarative:

```text
packages/Brewfile          Common Homebrew packages
packages/Brewfile.macos    macOS-only packages and casks
packages/Brewfile.linux    Linux-only packages
packages/cargo.txt         Cargo binaries
packages/npm.txt           Global npm packages
packages/skills.txt        Third-party Agent Skills repository paths
agent/settings.json        Pi packages and global Pi settings
agent/packages/pi-deep-work Local high-rigor Pi workflows and skills
```

Homebrew is used on Linux as well as macOS to keep the package setup consistent. Distro-specific package installation is intentionally outside the current scope.

## Local and work configuration

Do not commit credentials, hostnames, account identifiers, or employer-specific tools here.

The linker asks Nushell for its config directory (`$nu.default-config-dir`) and creates this untracked file there when it is absent, then loads it on startup:

```text
<nushell config dir>/local.nu
```

Use it for local aliases, private environment variables, and work tooling. Git identity and work-specific includes can remain in the normal global Git configuration alongside the managed Delta include.
