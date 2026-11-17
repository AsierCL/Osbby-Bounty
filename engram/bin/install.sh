#!/usr/bin/env bash
# Instalación reproducible del Engram del bounty en una máquina nueva.
# Requiere: docker con el plugin compose. No instala nada más, no toca tus datos del sistema.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v docker >/dev/null || { echo "falta docker"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "falta el plugin docker compose"; exit 1; }

mkdir -p "$HERE/data"
"$HERE/bin/engram-bounty" up
echo
echo "Listo. Para usar el bounty:   bin/gentle-bounty <programa>"
echo "El lanzador exporta ENGRAM_URL=http://127.0.0.1:${ENGRAM_PORT:-7438} y levanta este stack si hace falta."
