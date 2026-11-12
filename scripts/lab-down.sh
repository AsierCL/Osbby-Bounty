#!/bin/sh
# Baja el lab local. Idempotente: si no está corriendo, no falla (S57).
set -eu
cd "$(dirname "$0")/.."
if [ -f .lab/pid ]; then
	pid="$(cat .lab/pid)"
	if kill -0 "$pid" 2>/dev/null; then
		kill "$pid" 2>/dev/null || true
		i=0
		while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do
			i=$((i + 1))
			sleep 0.1
		done
		kill -9 "$pid" 2>/dev/null || true
	fi
	rm -f .lab/pid .lab/port
	echo "lab abajo"
else
	echo "el lab no estaba corriendo"
fi
