# install-remote-api.ps1
$ErrorActionPreference = "Stop"

function Get-DocsPath {
  try { return [Environment]::GetFolderPath("MyDocuments") } catch {}
  if ($env:USERPROFILE) { return Join-Path $env:USERPROFILE "Documents" }
  return Join-Path $HOME "Documents"
}

$SELF = $MyInvocation.MyCommand.Path
$ROOT = Split-Path -Parent $SELF

# Quelle finden (neben dem Installer oder im Repo unter ..\remote\)
$srcCandidates = @(
  (Join-Path $ROOT "Elgato_StreamDeckXL.js"),
  (Join-Path $ROOT "..\remote\Elgato_StreamDeckXL.js")
)
$src = $null
foreach ($c in $srcCandidates) {
  if (Test-Path $c) { $src = (Resolve-Path $c).Path; break }
}
if (-not $src) {
  Write-Error "Elgato_StreamDeckXL.js not found next to the installer (or ../remote)."
  exit 1
}

$docs = Get-DocsPath
$steinberg = Join-Path $docs "Steinberg"

# Mehr Varianten abdecken, in *alle* gefundenen installieren
$candidates = @(
  "Cubase 13","Cubase Pro 13","Cubase Artist 13",
  "Cubase 12","Cubase Pro 12","Cubase Artist 12",
  "Cubase 11","Cubase Pro 11","Cubase Artist 11",
  "Cubase",
  "Nuendo 13","Nuendo 12","Nuendo"
)

$targets = @()
foreach ($d in $candidates) {
  $p = Join-Path $steinberg $d
  if (Test-Path $p) { $targets += $p }
}

# Falls nichts gefunden wurde, lege eine neutrale Cubase-Struktur an
if ($targets.Count -eq 0) { $targets = @(Join-Path $steinberg "Cubase") }

$installed = @()
foreach ($base in $targets) {
  $targetDir = Join-Path $base "MIDI Remote\Driver Scripts\Local\Elgato\StreamDeckXL"
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $dest = Join-Path $targetDir "Elgato_StreamDeckXL.js"
  Copy-Item -Force -Path $src -Destination $dest

  Write-Host "Installed: $dest"
  $installed += $targetDir
}

# Zielordner öffnen (den ersten)
if ($installed.Count -gt 0) {
  Start-Process explorer.exe $installed[0] | Out-Null
} else {
  Write-Warning "No targets were created. Please verify your Documents\Steinberg structure."
}
