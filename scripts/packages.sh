#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info() {
  echo "[INFO] $*"
}

load_homebrew() {
  local candidate

  if command -v brew >/dev/null 2>&1; then
    eval "$(brew shellenv)"
    return
  fi

  for candidate in /opt/homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then
      eval "$("$candidate" shellenv)"
      return
    fi
  done
}

ensure_homebrew() {
  load_homebrew
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install Homebrew" >&2
    exit 1
  fi

  info "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_homebrew

  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew installation completed but brew is not available" >&2
    exit 1
  fi
}

install_brew_packages() {
  local platform_file

  case "$(uname -s)" in
    Darwin) platform_file="$REPO_ROOT/packages/Brewfile.macos" ;;
    Linux) platform_file="$REPO_ROOT/packages/Brewfile.linux" ;;
    *)
      echo "Unsupported operating system: $(uname -s)" >&2
      exit 1
      ;;
  esac

  info "Updating Homebrew"
  brew update
  brew bundle --file="$REPO_ROOT/packages/Brewfile"
  brew bundle --file="$platform_file"
}

build_bat_cache() {
  info "Building Bat theme cache"
  bat cache --build
}

install_rust_packages() {
  local package

  if ! command -v rustup >/dev/null 2>&1; then
    info "Installing rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  fi

  if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
  fi

  info "Updating Rust"
  rustup update stable

  while IFS= read -r package || [[ -n "$package" ]]; do
    [[ -z "$package" || "$package" == \#* ]] && continue
    info "Installing Cargo package: $package"
    if ! cargo binstall --no-confirm --force "$package"; then
      echo "[WARN] Failed to install Cargo package: $package; continuing" >&2
    fi
  done < "$REPO_ROOT/packages/cargo.txt"
}

install_npm_packages() {
  local package

  while IFS= read -r package || [[ -n "$package" ]]; do
    [[ -z "$package" || "$package" == \#* ]] && continue
    info "Installing npm package: $package"
    npm install --global "$package"
  done < "$REPO_ROOT/packages/npm.txt"
}

install_skills() {
  local line
  local repo
  local skill
  local skills
  local selected_skills

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    repo="${line%% *}"
    skills="${line#"$repo"}"

    if [[ -z "${skills// }" ]]; then
      info "Installing skills from $repo"
      skills add "$repo" --global --yes --agent universal </dev/null
      continue
    fi

    read -r -a selected_skills <<< "$skills"
    for skill in "${selected_skills[@]}"; do
      info "Installing skill $skill from $repo"
      skills add "$repo" --skill "$skill" --global --yes --agent universal </dev/null
    done
  done < "$REPO_ROOT/packages/skills.txt"
}

update_pi_packages() {
  if ! command -v pi >/dev/null 2>&1; then
    echo "[WARN] pi is not on PATH; skipping Pi package update" >&2
    return
  fi

  info "Updating Pi packages"
  pi update --extensions
}

ensure_homebrew
install_brew_packages
build_bat_cache
install_rust_packages
install_npm_packages
install_skills
update_pi_packages

info "Dependencies are up to date"
