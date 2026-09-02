# Platform-dependent configuration paths. Source this file; do not run it.
# Shared by links.sh (which creates the links) and doctor.sh (which checks them)
# so the two cannot drift apart.

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

case "$(uname -s)" in
  Darwin)
    if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
      NUSHELL_HOME="$CONFIG_HOME/nushell"
    else
      NUSHELL_HOME="$HOME/Library/Application Support/nushell"
    fi
    ZELLIJ_HOME="$HOME/.config/zellij"
    ;;
  Linux)
    NUSHELL_HOME="$CONFIG_HOME/nushell"
    ZELLIJ_HOME="$CONFIG_HOME/zellij"
    ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

# config.nu loads local.nu from `$nu.default-config-dir` at parse time, so the
# link target has to be the directory nu actually reads. Ask nu when it is
# available and keep the platform default for the first bootstrap.
if command -v nu >/dev/null 2>&1; then
  NUSHELL_HOME="$(nu --no-config-file -c '$nu.default-config-dir')"
fi
