#!/bin/sh
# Levanta el lab local en 127.0.0.1 y deja el puerto en .lab/port (S57).
# Solo localhost. No instala nada, no toca la red.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .lab
rm -f .lab/port

if [ -f .lab/pid ] && kill -0 "$(cat .lab/pid)" 2>/dev/null; then
	echo "el lab ya está corriendo (pid $(cat .lab/pid)), puerto $(cat .lab/port 2>/dev/null || echo '?')"
	exit 0
fi

LAB_PORT="${GENTLE_BOUNTY_LAB_PORT:-8787}"
nohup node --experimental-strip-types scripts/lab-serve.ts "$LAB_PORT" > .lab/lab.log 2>&1 &
echo $! > .lab/pid

i=0
while [ "$i" -lt 100 ]; do
	if [ -s .lab/port ]; then
		echo "lab arriba en http://127.0.0.1:$(cat .lab/port)  (pid $(cat .lab/pid))"
		exit 0
	fi
	i=$((i + 1))
	sleep 0.1
done

echo "el lab no arrancó; mirá .lab/lab.log" >&2
exit 1
