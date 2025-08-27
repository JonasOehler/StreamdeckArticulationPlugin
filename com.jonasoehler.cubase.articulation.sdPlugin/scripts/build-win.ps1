param(
  [string]$PluginFolderName = "com.jonasoehler.cubase.articulation.sdPlugin",
  [string]$DistSubdir = "dist\win"
)

$ErrorActionPreference = "Stop"

# Resolve paths. Script is expected in <repo>/<plugin>/scripts/build-win.ps1
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$CANDIDATE_PLUGIN = Split-Path -Parent $SCRIPT_DIR
$CANDIDATE_REPO   = Split-Path -Parent $CANDIDATE_PLUGIN

if (Test-Path (Join-Path $CANDIDATE_PLUGIN "manifest.json")) {
  $SRC  = $CANDIDATE_PLUGIN
  $ROOT = $CANDIDATE_REPO
} elseif (Test-Path (Join-Path $SCRIPT_DIR "manifest.json")) {
  $SRC  = $SCRIPT_DIR
  $ROOT = Split-Path -Parent $SRC
} else {
  $SRC  = Join-Path $CANDIDATE_REPO $PluginFolderName
  $ROOT = $CANDIDATE_REPO
}

if (!(Test-Path $SRC)) {
  throw "Plugin source folder not found: $SRC"
}

$OUTDIR   = Join-Path $SRC $DistSubdir
$PKGDIR   = Join-Path $OUTDIR (Split-Path -Leaf $SRC)
$DEST_DIR = Join-Path $SRC "dist"

if (!(Test-Path $DEST_DIR)) { New-Item -ItemType Directory -Force -Path $DEST_DIR | Out-Null }

Write-Host "[info] ROOT = $ROOT"
Write-Host "[info] SRC  = $SRC"
Write-Host "[info] OUT  = $PKGDIR"

# 1) Clean dist
if (Test-Path $OUTDIR) { Remove-Item -Recurse -Force $OUTDIR }
New-Item -ItemType Directory -Force -Path $PKGDIR | Out-Null

# 2) Bundle JS
Write-Host "[build] bundle plugin.cjs"
Push-Location $SRC
npm ci
node bundle.mjs
Pop-Location

# 3) Copy files
Write-Host "[build] copy files"
Copy-Item (Join-Path $SRC "manifest.json") $PKGDIR -Force
Copy-Item (Join-Path $SRC "plugin.cjs")    $PKGDIR -Force
if (Test-Path (Join-Path $SRC "profiles.json"))     { Copy-Item (Join-Path $SRC "profiles.json")     $PKGDIR -Force }
if (Test-Path (Join-Path $SRC "assets"))            { Copy-Item (Join-Path $SRC "assets")            $PKGDIR -Recurse -Force }
if (Test-Path (Join-Path $SRC "propertyinspector")) { Copy-Item (Join-Path $SRC "propertyinspector") $PKGDIR -Recurse -Force }

# 4) Install production deps in target (native addons)
Write-Host "[build] npm ci --omit=dev in $PKGDIR"
Copy-Item (Join-Path $SRC "package.json") $PKGDIR -Force
if (Test-Path (Join-Path $SRC "package-lock.json")) { Copy-Item (Join-Path $SRC "package-lock.json") $PKGDIR -Force }

Push-Location $PKGDIR
npm ci --omit=dev
Pop-Location

# 5) Optional sanity checks
$okCanvas = Test-Path "$PKGDIR\node_modules\@napi-rs\canvas-win32-x64-msvc\package.json"
$okMidi   = Test-Path "$PKGDIR\node_modules\@julusian\midi\package.json"
if (-not $okCanvas) { Write-Warning "@napi-rs/canvas (win32-x64-msvc) not found - check node_modules/@napi-rs/*" }
if (-not $okMidi)   { Write-Warning "@julusian/midi not found - check node_modules/@julusian/*" }

# 6) Package via Stream Deck CLI, fallback to zip rename
Write-Host "[pack] via Stream Deck CLI -> $DEST_DIR"
$packOk = $false
try {
  $env:Path += ";" + (npm root -g)
  $cliCmd = (Get-Command streamdeck -ErrorAction SilentlyContinue).Source
  if (-not $cliCmd) { throw "streamdeck CLI not found" }

  $args = @('package', '--source', $OUTDIR, '--output', $DEST_DIR)
  $proc = Start-Process -FilePath $cliCmd -ArgumentList $args -NoNewWindow -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "streamdeck package failed (exit $($proc.ExitCode))." }

  Write-Host "[done] Stream Deck CLI package created."
  $packOk = $true
}
catch {
  Write-Warning "CLI packaging failed or missing - will fallback to zip."
}

if (-not $packOk) {
  $zipTmp = Join-Path $DEST_DIR "com.jonasoehler.cubase.articulation-win.zip"
  if (Test-Path $zipTmp) { Remove-Item -Force $zipTmp }
  Compress-Archive -Path $PKGDIR -DestinationPath $zipTmp -Force

  $target = Join-Path $DEST_DIR "com.jonasoehler.cubase.articulation-win.streamDeckPlugin"
  if (Test-Path $target) { Remove-Item -Force $target }
  Rename-Item -Path $zipTmp -NewName (Split-Path $target -Leaf)
  Write-Host "[done] Fallback package created at $target"
}

Write-Host "Windows build and package done."
