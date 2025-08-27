# build-win.ps1 – Windows Build & Pack (CLI bevorzugt)
param(
  [string]$PluginFolderName = "com.jonasoehler.cubase.articulation.sdPlugin",
  [string]$DistRoot = "dist\win"
)

$ErrorActionPreference = "Stop"

function Have-StreamDeckCLI {
  return $null -ne (Get-Command streamdeck -ErrorAction SilentlyContinue)
}

# --- Pfade ermitteln: Skriptordner -> Projektroot -> Pluginroot ---
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROJECT_ROOT = Split-Path -Parent $SCRIPT_DIR

# Kandidaten, wo manifest.json liegen könnte
$candidates = @(
  $PROJECT_ROOT,                                      # Repo-Root = Plugin-Root
  (Join-Path $PROJECT_ROOT $PluginFolderName),        # Repo-Root/<PluginFolderName>
  (Split-Path -Parent $PROJECT_ROOT),                 # eine Ebene höher (falls scripts tiefer liegen)
  (Join-Path (Split-Path -Parent $PROJECT_ROOT) $PluginFolderName)
) | Where-Object { $_ -and (Test-Path $_) }

$SRC = $null
foreach ($c in $candidates) {
  if (Test-Path (Join-Path $c "manifest.json")) { $SRC = (Resolve-Path $c).Path; break }
}
if (-not $SRC) {
  $list = ($candidates | ForEach-Object { " - $_" }) -join "`n"
  throw "Plugin-Quellordner nicht gefunden. Getestete Pfade:`n$list"
}

$OUTDIR  = Join-Path $PROJECT_ROOT $DistRoot
$PKGDIR  = Join-Path $OUTDIR (Split-Path -Leaf $SRC)
$ZIP_DIR = Join-Path $PROJECT_ROOT "dist"

# gewünschte Enddatei
$OUT_SDP = Join-Path $ZIP_DIR "com.jonasoehler.cubase.articulation-win.streamDeckPlugin"
$OUT_ZIP = Join-Path $ZIP_DIR "com.jonasoehler.cubase.articulation-win.zip"

Write-Host "[info] SCRIPT_DIR   = $SCRIPT_DIR"
Write-Host "[info] PROJECT_ROOT = $PROJECT_ROOT"
Write-Host "[info] SRC          = $SRC"
Write-Host "[info] OUT          = $PKGDIR"

# --- Clean ---
if (Test-Path $OUTDIR) { Remove-Item -Recurse -Force $OUTDIR }
New-Item -ItemType Directory -Force -Path $PKGDIR | Out-Null
New-Item -ItemType Directory -Force -Path $ZIP_DIR | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $OUT_SDP, $OUT_ZIP

# --- Bundling (esbuild über bundle.mjs) ---
Write-Host "[build] bundle plugin.cjs"
Push-Location $SRC
npm i
node bundle.mjs
Pop-Location

# --- Dateien kopieren ---
Write-Host "[build] copy files"
Copy-Item (Join-Path $SRC "manifest.json") $PKGDIR -Force
Copy-Item (Join-Path $SRC "plugin.cjs")    $PKGDIR -Force
if (Test-Path (Join-Path $SRC "profiles.json"))        { Copy-Item (Join-Path $SRC "profiles.json") $PKGDIR -Force }
if (Test-Path (Join-Path $SRC "assets"))               { Copy-Item (Join-Path $SRC "assets") $PKGDIR -Recurse -Force }
if (Test-Path (Join-Path $SRC "propertyinspector"))    { Copy-Item (Join-Path $SRC "propertyinspector") $PKGDIR -Recurse -Force }

# --- Prod-Dependencies im Ziel (native Addons!) ---
Write-Host "[build] npm ci --omit=dev in $PKGDIR"
Copy-Item (Join-Path $SRC "package.json") $PKGDIR -Force
if (Test-Path (Join-Path $SRC "package-lock.json")) { Copy-Item (Join-Path $SRC "package-lock.json") $PKGDIR -Force }
Push-Location $PKGDIR
npm ci --omit=dev
Pop-Location

# --- Checks ---
$okCanvas = Test-Path "$PKGDIR\node_modules\@napi-rs\canvas-win32-x64-msvc\package.json"
$okMidi   = Test-Path "$PKGDIR\node_modules\@julusian\midi\package.json"
$okBundle = Test-Path "$PKGDIR\plugin.cjs"
if (-not $okBundle) { throw "plugin.cjs fehlt im Paketordner ($PKGDIR)." }
if (-not $okCanvas) { Write-Warning "@napi-rs/canvas (win32-x64-msvc) nicht gefunden – prüfe node_modules/@napi-rs/*" }
if (-not $okMidi)   { Write-Warning "@julusian/midi nicht gefunden – prüfe node_modules/@julusian/*" }

try {
  $m = Get-Content (Join-Path $PKGDIR "manifest.json") | ConvertFrom-Json
  if ($m.CodePath -ne "plugin.cjs") {
    Write-Warning "Manifest CodePath ist '$($m.CodePath)'; erwartet 'plugin.cjs'."
  }
} catch { Write-Warning "Konnte manifest.json nicht lesen: $($_.Exception.Message)" }

# --- Packen: Stream Deck CLI bevorzugt ---
if (Have-StreamDeckCLI) {
  Write-Host "[pack] via Stream Deck CLI → $ZIP_DIR"
  & streamdeck pack "$PKGDIR" --output "$ZIP_DIR" --force
  if ($LASTEXITCODE -ne 0) { throw "streamdeck pack fehlgeschlagen." }

  # neueste erzeugte Datei greifen und umbenennen
  $latest = Get-ChildItem -Path $ZIP_DIR -Filter *.streamDeckPlugin |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "Kein .streamDeckPlugin im Output gefunden." }
  if (Test-Path $OUT_SDP) { Remove-Item -Force $OUT_SDP }
  Move-Item -Force -Path $latest.FullName -Destination $OUT_SDP
} else {
  Write-Host "[pack] Fallback: zip → .streamDeckPlugin"
  Push-Location $OUTDIR
  if (Test-Path $OUT_ZIP) { Remove-Item -Force $OUT_ZIP }
  $folderName = Split-Path -Leaf $PKGDIR
  Compress-Archive -Path $folderName -DestinationPath $OUT_ZIP -Force
  Pop-Location
  if (Test-Path $OUT_SDP) { Remove-Item -Force $OUT_SDP }
  Rename-Item -Path $OUT_ZIP -NewName (Split-Path $OUT_SDP -Leaf)
}

Write-Host "[done] Windows Build fertig:"
Write-Host " - Ordner: $PKGDIR"
Write-Host " - Paket : $OUT_SDP"
