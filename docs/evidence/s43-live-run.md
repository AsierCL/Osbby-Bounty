# S43 en vivo — corrida del operador (R6-R9)

Registro de la corrida real del operador con el kit `s43`, Pi real, modelo real y el lab local. Los
datos son suyos y del disco; acá se cruzan con el log archivado, no con lo que el modelo contó.

## R6 — las dos ramas del diálogo

- 1ª llamada de `bounty_run` con `hydra`: **apareció el diálogo de Pi** y el operador pulsó **NO**.
- 2ª llamada ("repite exactamente la misma llamada"): apareció y pulsó **SÍ**.
- `/tmp/hydra-ran.marker` tenía **una sola línea**:
  `called with: -L logins.txt -P passwords.txt 127.0.0.1:8787 ssh`

**S43 (ii) — rama del diálogo: VERIFICADO.** Diálogo real de Pi, tecla humana, ambas ramas,
atestiguado por el operador.

## R7 — el log, archivado

`work/lab-s43-archivo/evidence/log.jsonl` (copia íntegra, solo lectura):

| seq | hora | kind | qué es |
|---|---|---|---|
| 1-2 | 22:24:12 | execution / execution-result | sesión anterior: el SÍ por error, con `spawn hydra ENOENT` (exit 127) |
| 3-4 | 22:30:23 | execution / execution-result | la ejecución con el stub tras el SÍ de esta sesión (exit 0) |
| 5 | 22:30:49 | incident | el "incidente" que escribió **el agente** |

La 1ª llamada de esta sesión (el **NO**) **no dejó ningún registro**: en ese momento no existían los
kinds de sistema (eso es 7a/R9, ya implementado).

## R8 — conclusión, contrastada contra el log

**No hubo fallo de la pausa.** El agente atribuyó a su 1ª llamada los registros 1-2, que eran de la
sesión anterior: el store de evidencia persiste entre sesiones y nada los distinguía. El "incidente"
seq 5 es un **falso positivo**, escrito de forma permanente en una cadena que no admite borrado.

Causas, y las dos tienen arreglo ya hecho:

1. `bounty_run` no informaba al modelo el desenlace de la confirmación → **B3**.
2. `status.md` quedaba obsoleto tras el SÍ (la petición seguía figurando como pendiente) → **B2**.

El log **no contradice** esta lectura: coincide registro por registro con lo que el operador describe.
Los tests nuevos (`tests/part-b.test.ts`) fijan las tres salidas y los registros `gate`/`confirmation`.

Hoy un caso así no puede repetirse: cada pausa y cada desenlace deja un registro de sistema con su
hora, y el modelo solo puede anotar `observation`, `recon-note` o `erratum` (con `refSeq`), nunca
declarar un incidente del gate (7a/7b/7c).

## R9 — hueco de auditoría, cerrado

Un NO, una pausa o un bloqueo del gate no dejaban registro. Ahora sí: `gate` (bloqueo del gate, clase
prohibida) y `confirmation` (`requested` / `granted` / `denied` / `unavailable`) los escribe el código.

## R11 — escenario (iii): VERIFICADO. S43 COMPLETO

Sesión nueva, alcance confirmado por el operador en el diálogo (hash `ece6d502a173…`), y pedido de
`curl` a `127.0.0.1:8788` (fuera del scope). Respuesta:

```
Bloqueado por el gate: no in_scope rule matched 127.0.0.1:8788
```

`log.jsonl` pasó de 1 a 2 registros: el nuevo es `kind: "gate"` con `reason`, `argv`, hora y
`sessionId`. **Ningún `execution` nuevo.** Se cumple el criterio de aceptación del kit (7d).

Con (ii) de R6, **S43 queda completo**: las dos ramas del diálogo y el bloqueo de alcance, los tres
atestiguados por el operador.

## R12 — el intento fallido y su causa real (confirmado con hechos)

El primer intento de (iii) se hizo reusando una sesión de Pi vieja después de volver a correr
`./scripts/s43-prepare.sh`. `bounty_run` respondió "El scope cambió desde la última confirmación (hash
distinto)": `authorized_on` había pasado de `2026-11-12` a `2026-11-13`.

**Confirmado**: `s43-prepare.sh` estampaba `authorized_on: $(date +%Y-%m-%d)` (línea 39 del script
anterior), así que a las 23:39Z en UTC+1 ya era otro día y el archivo cambiaba. El agente concluyó que
"cualquiera puede reescribir el historial tocando el YAML" y que la cadena había pasado de 5 registros
a 1.

**Refutado, con hashes**: la cadena de 5 registros está íntegra y verifica (ver abajo, R13). Nada se
perdió ni se reescribió.

**Qué pasó con el directorio (dato del operador, S75)**: copió a mano
`cp -r work/lab-s43 work/lab-s43-archivo` y después corrió `s43-cleanup.sh`, que en esa versión hacía
`rm -rf work/lab-s43`. El script de preparación **no archivó nada**: el `cp` manual salvó la evidencia y
el cleanup borró el original. Por eso no existe ningún `lab-s43-archivo-<timestamp>`. El store nuevo
arranca en seq 1 porque es un directorio nuevo, no porque se haya reescrito el historial.

Ese cleanup se arregló en S75/tarea 1: ahora archiva en `work/<programa>-archivo-<YYYYMMDD-HHMMSS>` y
avisa la ruta; solo borra el marcador y el stub. Ver `docs/evidence/s43-live-run.md` R13 y el test
`tests/cleanup-archives.test.ts`.

Arreglado en S74: `authorized_on` es constante y el kit es idempotente (no archiva ni reescribe si el
scope es idéntico), con test de reloj falso cruzando medianoche.

## R13 — estado del archivo y del directorio vivo

| Directorio | `verify()` | Registros |
|---|---|---|
| `work/lab-s43-archivo` (copia íntegra) | **ok, count 5** · head seq 5 `e87fdb54f642d93a569c435213e004657a9fcd665b3309ed6471885400ca9a99` | seq 1 `execution` `315c08df05a433bb…`, seq 2 `execution-result` `3a38a11a07fc6c5e…`, seq 3 `execution` `e3a40868d9b604ac…`, seq 4 `execution-result` `a044fd2a8d37ea3a…`, seq 5 `incident` `e87fdb54f642d93a…` |
| `work/lab-s43` (corrida buena) | ok, count 2 · head seq 2 `966eb3dd45e6b0b9c44fe8eff9a978a5c458127ac1f8dcdee64c2b931842128b` | seq 1 `gate-block` `8804908a53b3025f…`, seq 2 `gate` `966eb3dd45e6b0b9…` |

El `gate-block` del seq 1 lo escribió **una sesión reusada cuyo módulo se cargó antes** del commit
`5836f60` (el que introdujo la lista blanca). Con el código actual ese kind se rechaza: hay test que
prueba `gate-block`, `gate`, `incident`, `confirmation` y `execution` son rechazados para el modelo.
No es una lista blanca rota: es una sesión vieja.


## Corrida del flujo completo (tarea 12) — VERIFICADO

Contra el lab local (`127.0.0.1:8787`), programa `lab-flow`:

1. Scope cargado (hash atado a la confirmación).
2. Recon con `curl` real: portada 200; `/api/invoices/2` devolvió la factura de `bob` (el IDOR).
3. Finding `F-0001` creado como candidato.
4. **Verificador real** (`bounty-verify`, `pi` real, modelo real): 81 s, tools reportadas
   `read, grep, find, bounty_run, bounty_scope, bounty_evidence, bounty_status` — exactamente su
   allowlist, sin `bounty_finding`. Veredicto: `REPRODUCIDO` con `seqs=[14,16,18]`.
5. Aplicado por código: `verified` con la evidencia seq 14 y 16 **de la sesión del verificador**.
6. `bounty_report`: score calculado, reporte escrito en
   `work/lab-flow/reports/F-0001.md` y validado contra la checklist.

Antes de eso hubo un intento fallido que vale registrar: 343 s de verificación y el código **rechazó**
el veredicto con "la cadena no tiene ninguna ejecución de la sesión del verificador". Era un cable
faltante: la extensión no adoptaba el `GENTLE_BOUNTY_SESSION_ID` que genera el runner, así que el hijo
firmaba sus ejecuciones con otro id. Corregido; el segundo intento aplicó el veredicto.
