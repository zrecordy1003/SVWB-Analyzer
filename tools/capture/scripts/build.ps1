$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$manifest = Join-Path $repoRoot 'tools\capture\Cargo.toml'
$artifact = Join-Path $repoRoot 'tools\target\release\svwb-capture-tool.exe'
$destination = Join-Path $repoRoot 'tools\svwb-capture-tool.exe'

cargo build --manifest-path $manifest --release
Copy-Item -LiteralPath $artifact -Destination $destination -Force
