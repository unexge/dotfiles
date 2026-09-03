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
- Zellij with the pinned zjstatus v0.25.0 bottom-bar plugin
- `magit` terminal launcher
- Pi instructions, settings, skills, themes, and the local `pi-deep-work` package
- Agent workflow commands under `agent/bin/`

Only files tracked in this repository are linked, and links pointing at files the repository no longer contains are removed on the next `dot link`. Existing target files are moved to timestamped `.bak.*` paths before links are created. Mutable application directories are not linked wholesale, so history, caches, and local state remain outside the repository.

For the managed `pi-deep-work` package, run `/deep config` once for machine-wide model roles and `/deep init` in each trusted repository that needs `build` or `fix`. By personal convention, `config/git/ignore` keeps `.pi/pi-deep-work.json` machine-local. This overrides the package's recommended committed-policy trust model; force-add the file in repositories where the policy should be versioned and shared.

Zellij downloads the pinned zjstatus WebAssembly release from GitHub on first use. Zellij then asks once for `ReadApplicationState`, `ChangeApplicationState`, and `RunCommands`; zjstatus requests the last permission unconditionally, although this configuration runs no bar commands. `dot link` renders machine-local label settings into Zellij's generated configuration so they are present on the first frame.

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

## Remote Linux access

Run `dot sync` on both machines so [Mosh](https://mosh.org/) and Zellij are available. Mosh uses SSH to authenticate and then connects over UDP, so allow UDP ports `60000-61000` from trusted client networks to the Linux box.

Define a machine-local SSH alias in `~/.ssh/config`:

```sshconfig
Host remotebox
    HostName linux.example.com
    User your-user
```

Add a matching command to the untracked Nushell `local.nu`:

```nu
alias remotebox = mosh -- remotebox /home/linuxbrew/.linuxbrew/bin/zellij attach --create
```

The absolute path avoids depending on the non-interactive remote `PATH`; replace it with the output of `command -v zellij` on the Linux box when Homebrew uses a different prefix. `zellij attach --create` attaches to an existing remote session or creates one when needed.

## Local and work configuration

Do not commit credentials, hostnames, account identifiers, or employer-specific tools here.

The linker asks Nushell for its config directory (`$nu.default-config-dir`) and creates this untracked file there when it is absent, then loads it on startup:

```text
<nushell config dir>/local.nu
```

Use it for local aliases, private environment variables, and work tooling. Git identity and work-specific includes can remain in the normal global Git configuration alongside the managed Delta include.

Set an optional machine-specific Zellij label and color there:

```nu
$env.ZELLIJ_LABEL = "M1 Pro"
$env.ZELLIJ_LABEL_COLOR = "#73b8ff"
```

The bottom bar displays `Zellij` when `ZELLIJ_LABEL` is absent and gray `#cccac2` when `ZELLIJ_LABEL_COLOR` is absent. Run `dot link` and start a fresh Zellij session after changing either value.
