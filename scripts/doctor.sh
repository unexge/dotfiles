#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/platform.sh"

ORIGINAL_PATH="$PATH"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:$PATH"

missing=0
for command_name in \
  bazelisk brew btop cargo cargo-binstall crit delta dex difft dust emacs htop \
  hunkdiff hx jj jq node npm nu pi rg ruby rust-code-analysis-cli rustup uv \
  zellij zig; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[ERROR] Missing command: $command_name" >&2
    missing=1
  fi
done

for target in \
  "$HOME/.local/bin/dot" \
  "$HOME/.local/bin/magit" \
  "$HOME/.local/bin/agent-loop" \
  "$HOME/.pi/agent/AGENTS.md" \
  "$HOME/.pi/agent/settings.json" \
  "$HOME/.pi/agent/packages/pi-deep-work/package.json" \
  "$HOME/.claude/CLAUDE.md" \
  "$HOME/.emacs.d/init.el" \
  "$CONFIG_HOME/git/ignore" \
  "$CONFIG_HOME/git/delta.gitconfig" \
  "$CONFIG_HOME/helix/config.toml" \
  "$CONFIG_HOME/hunk/extensions/reviewed-files/index.tsx" \
  "$NUSHELL_HOME/config.nu" \
  "$NUSHELL_HOME/env.nu" \
  "$ZELLIJ_HOME/config.kdl"; do
  if [[ ! -L "$target" ]]; then
    echo "[ERROR] Expected managed link: $target" >&2
    missing=1
  fi
done

if [[ ":$ORIGINAL_PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo "[WARN] Add $HOME/.local/bin to your shell PATH"
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "[INFO] dotfiles is healthy"
