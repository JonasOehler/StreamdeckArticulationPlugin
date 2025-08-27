#!/usr/bin/env bash
set -euo pipefail

PLUGIN_FOLDER_NAME="com.jonasoehler.cubase.articulation.sdPlugin"
DIST_ROOT="dist/mac"

# ROOT = repo root (eine Ebene über scripts/)
ROOT="$(cd "$(dirname "$0")"/.. && pwd)"

# SRC bestimmen (bereits im Plugin-Ordner oder eine Ebene drüber)
if [[ -f "$ROOT/manifest.json" ]]; then
  SRC="$ROOT"
elif [[ -f "$ROOT/$PLUGIN_FOLDER_NAME/manifest.json" ]]; then
  SRC="$ROOT/$PLUGIN_FOLDER_NAME"
else
  echo "Plugin source with manifest.json not found under: $ROOT or $ROOT/$PLUGIN_FOLDER_NAME" >&2
  exit 1
fi

OUTDIR="$ROOT/$DIST_ROOT"
PKGDIR="$OUTDIR/$(basename "$SRC")"
DESTROOT="$ROOT/dist"

echo "[info] ROOT       = $ROOT"
echo "[info] SRC        = $SRC"
echo "[info] OUT        = $PKGDIR"
echo "[info] DESTROOT   = $DESTROOT"

# Clean
rm -rf "$OUTDIR"
mkdir -p "$PKGDIR" "$DESTROOT"

# Bundle
echo "[build] bundle plugin.cjs"
pushd "$SRC" >/dev/null
npm i
node bundle.mjs
popd >/dev/null

# Dateien kopieren (OHNE remote/ – Installer liefern wir separat als Release-Asset)
echo "[build] copy files"
cp "$SRC/manifest.json" "$PKGDIR/manifest.json"
cp "$SRC/plugin.cjs" "$PKGDIR"
[[ -f "$SRC/profiles.json" ]] && cp "$SRC/profiles.json" "$PKGDIR"
[[ -d "$SRC/assets" ]] && cp -R "$SRC/assets" "$PKGDIR"
[[ -d "$SRC/propertyinspector" ]] && cp -R "$SRC/propertyinspector" "$PKGDIR"

# Manifest sicherstellen: CodePath -> plugin.cjs
node -e 'const fs=require("fs"); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,"utf8")); m.CodePath="plugin.cjs"; fs.writeFileSync(p, JSON.stringify(m,null,2));' "$PKGDIR/manifest.json"

# Production-Deps im Ziel (native Addons)
echo "[build] npm ci --omit=dev in $PKGDIR"
cp "$SRC/package.json" "$PKGDIR"
[[ -f "$SRC/package-lock.json" ]] && cp "$SRC/package-lock.json" "$PKGDIR"
pushd "$PKGDIR" >/dev/null
npm ci --omit=dev
popd >/dev/null

# Sanity-Checks
if [[ ! -f "$PKGDIR/node_modules/@napi-rs/canvas-darwin-arm64/package.json" && \
      ! -f "$PKGDIR/node_modules/@napi-rs/canvas-darwin-x64/package.json" ]]; then
  echo "[warn] @napi-rs/canvas (darwin) not found under node_modules/@napi-rs/*"
fi
if [[ ! -f "$PKGDIR/node_modules/@julusian/midi/package.json" ]]; then
  echo "[warn] @julusian/midi not found under node_modules/@julusian/*"
fi

# Packen via CLI (Fallback: zip -> .streamDeckPlugin)
echo "[pack] using Stream Deck CLI into $DESTROOT"
_cli_fail=0
if command -v streamdeck >/dev/null 2>&1; then
  streamdeck package --source "$OUTDIR" --output "$DESTROOT" || _cli_fail=1
else
  _cli_fail=1
fi

if [[ "${_cli_fail}" -ne 0 ]]; then
  echo "[pack] CLI not available or failed. Fallback zip -> .streamDeckPlugin"
  ZIP="$DESTROOT/com.jonasoehler.cubase.articulation-mac.zip"
  PKG="$DESTROOT/com.jonasoehler.cubase.articulation-mac.streamDeckPlugin"
  rm -f "$ZIP" "$PKG"
  (cd "$OUTDIR" && zip -r -q "$ZIP" "$(basename "$PKGDIR")")
  mv "$ZIP" "$PKG"
  echo "[pack] created $PKG"
fi

echo "macOS build and package completed."
