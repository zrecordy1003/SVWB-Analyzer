# Publishes the installer that is ALREADY in dist/, rather than building a new
# one during publish.
#
# `electron-builder --publish always` rebuilt before uploading, so the binary
# users downloaded was never the binary that passed the manual test pass (NSIS
# output is not reproducible - it embeds a timestamp). It also cost a second
# 35s NSIS compression. This script uploads the exact files `build:win`
# produced, so "tested" and "shipped" are the same bytes.
#
# Everything here is a precondition check except the last two steps. The checks
# exist because every one of them has a silent failure mode:
#
#   - a version already on GitHub: electron-builder used to REPLACE that
#     release's installer, and electron-updater would not offer it to anyone
#     (same version), so the release page changed under existing users.
#   - latest.yml disagreeing with the .exe: every auto-update fails its
#     integrity check, silently.
#   - a missing .blockmap: differential download falls back to a full ~90MB
#     download, and only a log line says so.
#   - an asset name that does not match latest.yml's `url`: every update 404s.
#     This is why build.nsis.artifactName is a literal dashed string - the
#     files on disk have to be named exactly what latest.yml points at, and
#     exactly what previous releases were named, because electron-updater
#     derives the old .blockmap URL from that same pattern.

param(
    # Release from a dirty tree. Only for a re-upload after a failed push -
    # never for a first publish, because the artifacts in dist/ would then not
    # correspond to any commit.
    [switch]$AllowDirty,
    # Run every check and report, then stop without tagging or uploading.
    [switch]$DryRun
)

# `param` has to be the first statement in the file, so this cannot move up.
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

# Write-Error would wrap the message in a call-stack frame, which buries the
# one line the reader needs. This is a release gate, not a stack trace.
function Fail($message) {
    [Console]::Error.WriteLine("`nrelease-win: $message`n")
    exit 1
}

# --- gh -----------------------------------------------------------------

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $fallback = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
    if (Test-Path $fallback) { $gh = $fallback }
}
if (-not $gh) {
    Fail "GitHub CLI not found. Install it, or add gh.exe to PATH."
}

& $gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "gh is not authenticated. Run: gh auth login"
}

# --- version and artifacts ---------------------------------------------

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"

$exeName = "SVWB-Analyzer-Setup-$version.exe"
$exe = Join-Path 'dist' $exeName
$blockmap = "$exe.blockmap"
$latestYml = Join-Path 'dist' 'latest.yml'

foreach ($f in @($exe, $blockmap, $latestYml)) {
    if (-not (Test-Path $f)) {
        Fail "$f is missing. Run: pnpm run build:win"
    }
}

# --- the version must not already be published -------------------------

& $gh release view $tag *> $null
if ($LASTEXITCODE -eq 0) {
    Fail @"
$tag already exists on GitHub. Bump the version field in package.json and rebuild.
Re-publishing a released version replaces its installer while existing users
are never offered the update - the release page changes silently.
"@
}

# --- the tree must match what was built --------------------------------

if (-not $AllowDirty) {
    $dirty = git status --porcelain
    if ($dirty) {
        Fail @"
The working tree is dirty, so the artifacts in dist/ do not correspond to any
commit. Commit first, or pass -AllowDirty if you are re-uploading after a
failed push.
"@
    }
}

# --- latest.yml must describe the .exe on disk -------------------------

$yml = Get-Content $latestYml -Raw

$declaredUrl = ([regex]::Match($yml, '(?m)^\s*-\s*url:\s*(\S+)\s*$')).Groups[1].Value
$declaredSize = ([regex]::Match($yml, '(?m)^\s*size:\s*(\d+)\s*$')).Groups[1].Value
$declaredSha = ([regex]::Match($yml, '(?m)^sha512:\s*(\S+)\s*$')).Groups[1].Value

if (-not $declaredUrl -or -not $declaredSize -or -not $declaredSha) {
    Fail "Could not parse url/size/sha512 out of $latestYml."
}

if ($declaredUrl -ne $exeName) {
    Fail @"
latest.yml points at '$declaredUrl' but the file on disk is '$exeName'.
Auto-update would request a URL that does not exist. Check
build.nsis.artifactName.
"@
}

$actualSize = (Get-Item $exe).Length
if ("$actualSize" -ne $declaredSize) {
    Fail "latest.yml declares size $declaredSize, $exeName is $actualSize bytes."
}

$sha512 = [System.Security.Cryptography.SHA512]::Create()
$stream = [System.IO.File]::OpenRead((Resolve-Path $exe))
try { $actualSha = [Convert]::ToBase64String($sha512.ComputeHash($stream)) }
finally { $stream.Dispose() }

if ($actualSha -ne $declaredSha) {
    Fail @"
latest.yml's sha512 does not match $exeName. Every auto-update would fail its
integrity check, silently.
  latest.yml: $declaredSha
  on disk:    $actualSha
"@
}

Write-Host "Verified $exeName"
Write-Host "  size    $actualSize"
Write-Host "  sha512  $actualSha"
Write-Host "  blockmap and latest.yml present, $tag is free"

if ($DryRun) {
    Write-Host "`n-DryRun: stopping before the tag and the upload."
    exit 0
}

# --- tag, then upload --------------------------------------------------

# Annotated, to match every v1.0.x tag. electron-builder created lightweight
# ones, which is why this is done here rather than left to the publish step.
if (-not (git tag --list $tag)) {
    git tag -a $tag -m "Release $version"
    if ($LASTEXITCODE -ne 0) { Fail "Could not create tag $tag." }
}

git push origin $tag
if ($LASTEXITCODE -ne 0) { Fail "Could not push $tag." }

# All three files in one call: a release carrying the .exe but not latest.yml
# is invisible to the updater, and one without the .blockmap costs every user
# a full download.
& $gh release create $tag `
    --title $version `
    --notes "Release notes pending." `
    $exe $blockmap $latestYml
if ($LASTEXITCODE -ne 0) { Fail "gh release create failed. The tag is pushed; re-run to retry the upload." }

Write-Host "`nPublished $tag. Write the release notes on GitHub."
