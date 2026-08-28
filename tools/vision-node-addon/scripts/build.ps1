$ErrorActionPreference = 'Stop'

# Builds the Rust template-matching addon and drops it next to the capture tool.
# The cdylib is renamed to .node so it can be require()d directly; no
# @napi-rs/cli or node-gyp step is involved, and nothing is compiled on the
# user's machine.

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$manifest = Join-Path $repoRoot 'tools\vision-node-addon\Cargo.toml'
$artifact = Join-Path $repoRoot 'tools\target\release\svwb_vision_node_addon.dll'
$destination = Join-Path $repoRoot 'tools\svwb-vision.node'

cargo build --manifest-path $manifest --release

# Windows locks a loaded .node, so a still-running dev script (or the app
# itself) makes the copy fail with a bare IOException. Say so plainly instead.
try {
    Copy-Item -LiteralPath $artifact -Destination $destination -Force -ErrorAction Stop
} catch [System.IO.IOException] {
    Write-Error @"
Cannot replace $destination - the file is loaded by a running process.
Close the app, or stop any script that required it, then re-run this build.
"@
    exit 1
}
