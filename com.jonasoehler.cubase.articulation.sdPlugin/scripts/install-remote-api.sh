#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# Quelle finden (neben dem Installer oder im Repo unter ../remote)
if [[ -f "$DIR/Elgato_StreamDeckXL.js" ]]; then
  SRC="$DIR/Elgato_StreamDeckXL.js"
elif [[ -f "$DIR/../remote/Elgato_StreamDeckXL.js" ]]; then
  SRC="$DIR/../remote/Elgato_StreamDeckXL.js"
else
  echo "Elgato_StreamDeckXL.js not found next to the installer (or ../remote)." >&2
  exit 1
fi

DOCS="$HOME/Documents"
STEINBERG="$DOCS/Steinberg"

# Mehr Varianten abdecken; in *alle* gefundenen installieren
CANDIDATES=("Cubase 13" "Cubase Pro 13" "Cubase Artist 13"
            "Cubase 12" "Cubase Pro 12" "Cubase Artist 12"
            "Cubase 11" "Cubase Pro 11" "Cubase Artist 11"
            "Cubase"
            "Nuendo 13" "Nuendo 12" "Nuendo")

BASES=()
for d in "${CANDIDATES[@]}"; do
  [[ -d "$STEINBERG/$d" ]] && BASES+=("$STEINBERG/$d")
done
# Fallback
[[ ${#BASES[@]} -eq 0 ]] && BASES+=("$STEINBERG/Cubase")

INSTALLED=()
for base in "${BASES[@]}"; do
  TARGET_DIR="$base/MIDI Remote/Driver Scripts/Local/Elgato/StreamDeckXL"
  mkdir -p "$TARGET_DIR"
  DEST="$TARGET_DIR/Elgato_StreamDeckXL.js"
  cp -f "$SRC" "$DEST"
  echo "Installed: $DEST"
  INSTALLED+=("$TARGET_DIR")
done

# ersten Zielordner im Finder öffnen
if [[ ${#INSTALLED[@]} -gt 0 ]]; then
  open "${INSTALLED[0]}" >/dev/null 2>&1 || true
else
  echo "No targets were created. Please verify your Documents/Steinberg structure." >&2
fi
