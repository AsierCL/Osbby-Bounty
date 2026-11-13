#!/bin/sh
# Limpia el kit de la prueba S43 (S65). Idempotente.
#
# S75/task 1: la evidencia no se borra. El directorio de trabajo se archiva con timestamp y se avisa
# de la ruta; solo se borran lo que sí es desechable: el marcador del hydra y el stub del PATH.
set -eu
ROOT="${GENTLE_BOUNTY_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BIN_DIR="${GENTLE_BOUNTY_S43_BIN:-/tmp/bounty-bin}"
MARKER="${GENTLE_BOUNTY_S43_MARKER:-/tmp/hydra-ran.marker}"
PROGRAM="lab-s43"
WORK="$ROOT/work/$PROGRAM"

rm -f "$MARKER"
rm -f "$BIN_DIR/hydra"

if [ -d "$WORK" ] && [ -n "$(ls -A "$WORK" 2>/dev/null)" ]; then
	ARCHIVE="$ROOT/work/$PROGRAM-archivo-$(date +%Y%m%d-%H%M%S)"
	mv "$WORK" "$ARCHIVE"
	echo "evidencia archivada en $ARCHIVE (no se borró nada)"
else
	rmdir "$WORK" 2>/dev/null || true
	echo "no había evidencia que archivar"
fi

if [ -f "$ROOT/.bounty/config.json" ]; then
	node -e '
const fs = require("node:fs");
const path = process.argv[1];
const bin = process.argv[2];
try {
  const doc = JSON.parse(fs.readFileSync(path, "utf8") || "{}");
  if (Array.isArray(doc.tool_path)) {
    doc.tool_path = doc.tool_path.filter((entry) => entry !== bin);
    fs.writeFileSync(path, JSON.stringify(doc, null, "\t") + "\n");
  }
} catch { /* config ilegible: no lo toco */ }
' "$ROOT/.bounty/config.json" "$BIN_DIR"
fi
rmdir "$BIN_DIR" 2>/dev/null || true
echo "kit S43 limpio (marcador y hydra borrados; la evidencia queda archivada)"
