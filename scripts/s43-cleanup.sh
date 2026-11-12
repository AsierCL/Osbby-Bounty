#!/bin/sh
# Limpia el kit de la prueba S43 (S65). Idempotente.
set -eu
ROOT="${GENTLE_BOUNTY_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BIN_DIR="${GENTLE_BOUNTY_S43_BIN:-/tmp/bounty-bin}"
MARKER="${GENTLE_BOUNTY_S43_MARKER:-/tmp/hydra-ran.marker}"
rm -f "$MARKER"
rm -rf "$ROOT/work/lab-s43"
rm -f "$BIN_DIR/hydra"
rmdir "$BIN_DIR" 2>/dev/null || true
echo "kit S43 limpio (marcador, work/lab-s43 y el hydra inofensivo)"
