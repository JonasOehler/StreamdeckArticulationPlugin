#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
/bin/bash "$DIR/install-remote-api.sh"
printf "\nDone. You can close this window.\n"
read -r -p "Press Enter to exit…"
