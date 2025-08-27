#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/install-remote-api.sh"
read -n 1 -s -r -p "Done. Press any key to close…"
