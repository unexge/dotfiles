$env.config.show_banner = false
$env.PROMPT_COMMAND_RIGHT = ""

source ./themes/ayu.nu

# local.nu carries aliases and commands as well as environment variables, so it
# needs `source`. `source` is a parse-time keyword, so a missing local.nu is a
# hard startup error and cannot be guarded with `if`; scripts/links.sh creates
# the stub in the directory nu itself reports as its config dir.
const local_config = ($nu.default-config-dir | path join "local.nu")
source $local_config
