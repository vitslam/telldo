#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
if command -v Xvfb >/dev/null; then TELLDO_XVFB="$(command -v Xvfb)"; else
 TELLDO_XVFB="$PWD/.tools/xvfb/usr/bin/Xvfb"
 export LD_LIBRARY_PATH="$PWD/.tools/xvfb/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
TELLDO_DISPLAY_FILE="$(mktemp)"
"$TELLDO_XVFB" -xkbdir "$PWD/.tools/xvfb/usr/share/X11/xkb" -displayfd 3 -screen 0 1440x960x24 -nolisten tcp 3>"$TELLDO_DISPLAY_FILE" >.tools/xvfb.log 2>&1 &
TELLDO_XVFB_PID=$!
trap 'kill "$TELLDO_XVFB_PID" 2>/dev/null || true; rm -f "$TELLDO_DISPLAY_FILE"' EXIT
for i in {1..50}; do test -s "$TELLDO_DISPLAY_FILE" && break; sleep 0.1; done
test -s "$TELLDO_DISPLAY_FILE" || { cat .tools/xvfb.log; exit 1; }
export DISPLAY=":$(cat "$TELLDO_DISPLAY_FILE")"
if (( $# )); then "$@"; else npm run test:smoke; fi
