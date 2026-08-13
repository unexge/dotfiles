$env.config.show_banner = false
$env.PROMPT_COMMAND_RIGHT = ""

use ./themes/gruvbox-dark-hard.nu

# `source-env` is a parse-time keyword, so a missing local.nu is a hard startup
# error and cannot be guarded with `if`. scripts/links.sh creates the stub in
# the directory nu itself reports as its config dir.
const local_config = ($nu.default-config-dir | path join "local.nu")
source-env $local_config
