$env.EDITOR = "hx"

$env.PATH = ($env.PATH | prepend ($env.HOME | path join ".local" "bin"))
$env.PATH = ($env.PATH | prepend ($env.HOME | path join ".cargo" "bin"))

if ("/opt/homebrew/bin" | path exists) {
    $env.PATH = ($env.PATH | prepend "/opt/homebrew/bin")
} else if ("/home/linuxbrew/.linuxbrew/bin" | path exists) {
    $env.PATH = ($env.PATH | prepend "/home/linuxbrew/.linuxbrew/bin")
}
