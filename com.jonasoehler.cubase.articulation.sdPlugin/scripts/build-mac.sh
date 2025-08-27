#!/usr/bin/env bash
set -euo pipefail

PLUGIN_FOLDER_NAME="com.jonasoehler.cubase.articulation.sdPlugin"
DIST_ROOT="dist/mac"

# Skriptordner -> Projektroot -> Kandidaten ermitteln
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$PROJECT_ROOT/manifest.json" ]]; then
  SRC="$PROJECT_ROOT"
elif [[ -f "$PROJECT_ROOT/$PLUGIN_FOLDER_NAME/manifest.json" ]]; then
  SRC="$PROJECT_ROOT/$PLUGIN_FOLDER_NAME"
else
  echo "Plugin-Quellordner nicht gefunden. Getestet:"
  echo " - $PROJECT_ROOT"
  echo " - $PROJECT_ROOT/$PLUGIN_FOLDER_NAME"
  exit 1
fi

OUTDIR="$PROJECT_ROOT/$DIST_ROOT"
PKGDIR="$OUTDIR/$(basename "$SRC")"
ZIP_DIR="$PROJECT_ROOT/dist"

ZIP_BASENAME="com.jonasoehler.cubase.articulation-mac"
ZIP_TMP="$ZIP_DIR/$ZIP_BASENAME.zip"
PKG="$ZIP_DIR/$ZIP_BASENAME.streamDeckPlugin"

echo "[info] SCRIPT_DIR    = $SCRIPT_DIR"
echo "[info] PROJECT_ROOT  = $PROJECT_ROOT"
echo "[info] SRC           = $SRC"
echo "[info] OUT           = $PKGDIR"

# Clean
rm -rf "$OUTDIR"
mkdir -p "$PKGDIR" "$ZIP_DIR"
rm -f "$ZIP_TMP" "$PKG"

# Bundling
echo "[build] bundle plugin.cjs"
pushd "$SRC" >/dev/null
npm i
node bundle.mjs
popd >/dev/null

# Dateien kopieren
echo "[build] copy files"
cp "$SRC/manifest.json" "$PKGDIR"
cp "$SRC/plugin.cjs"    "$PKGDIR"
[[ -f "$SRC/profiles.json" ]] && cp "$SRC/profiles.json" "$PKGDIR"
[[ -d "$SRC/assets" ]] && cp -R "$SRC/assets" "$PKGDIR"
[[ -d "$SRC/propertyinspector" ]] && cp -R "$SRC/propertyinspector" "$PKGDIR"

# Prod-Deps im Ziel
echo "[build] npm ci --omit=dev in $PKGDIR"
cp "$SRC/package.json" "$PKGDIR"
[[ -f "$SRC/package-lock.json" ]] && cp "$SRC/package-lock.json" "$PKGDIR"
pushd "$PKGDIR" >/dev/null
npm ci --omit=dev
popd >/dev/null

# Sanity
[[ -f "$PKGDIR/plugin.cjs" ]] || { echo "plugin.cjs fehlt im Paketordner ($PKGDIR)"; exit 1; }

# Packen (zip → rename)
echo "[pack] zip → $ZIP_TMP"
(
  cd "$OUTDIR"
  zip -r -q "$ZIP_TMP" "$(basename "$PKGDIR")"
)
echo "[pack] rename → $PKG"
mv "$ZIP_TMP" "$PKG"

echo "[done] macOS Build fertig:"
echo " - Ordner: $PKGDIR"
echo " - Paket : $PKG"
