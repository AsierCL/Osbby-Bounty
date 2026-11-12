# Evidencia: pausa destructiva (S43)

Acá está separado lo que **corrió de verdad** de lo que **no**. La línea roja #2 no admite
"documentado y listo", así que conviene leer las tres secciones.

## 1. Verificado: el camino de confirmación, con proceso real

`tests/extension.test.ts` carga la extensión real, registra sus tools en un `pi` falso mínimo, e
invoca `bounty_run` con `hydra` contra un binario de prueba que escribe un marcador. La confirmación
llega por un callback con la misma firma documentada de `ctx.ui.confirm(title, message)`.

| Respuesta | Preguntas | ¿Se ejecutó el binario? | `status.md` |
|---|---|---|---|
| no | 1 (menciona `brute-force`) | **no** (marcador ausente) | "destructiva necesita tu OK explícito" |
| sí | 1 | **sí** (marcador escrito) | — |

Esto cubre: clasificación inferida, pausa, pregunta, respuesta, y ejecución condicionada, con spawn
de proceso real. No cubre el widget de Pi ni la tecla.

## 2. Verificado: Pi real carga la extensión y limita las tools

Ver `docs/evidence/main-session-tools.md`: la sesión principal reporta exactamente
`read, grep, find, ls` + las siete tools de bounty. Sin `bash`, `write`, `fetch`.

## 3. NO VERIFICADO: el diálogo de Pi y la tecla del humano

Se intentó, y no salió:

- **Modo RPC.** El protocolo de diálogo existe y está documentado
  (`docs/rpc-extension-ui.md`: `extension_ui_request` con `method: "confirm"`, respuesta
  `extension_ui_response` con `confirmed: true/false`). Pero `docs/rpc-commands.md` **no expone un
  comando para invocar una tool** sin pasar por el modelo: solo `prompt`, `steer`, `state`, `model`,
  etc. Sin eso no hay forma headless de disparar `bounty_run` y responder el diálogo.
- **Modo JSON con el modelo.** Tres corridas reales: en una el modelo nunca llamó a `bounty_run`
  (exploró el repo); en otra la llamó antes de que el scope terminara de cargar (bug mío, corregido:
  el preload ahora se espera); en la tercera volvió a explorar en vez de llamar. **Inconcluso, no
  prueba de nada**, y no lo voy a presentar como si lo fuera.

### Procedimiento manual (2 minutos, lo hacés vos)

```bash
cd /home/opencode-agent/GentleBounty/gentle-bounty
./scripts/lab-up.sh              # deja el puerto real en .lab/port
./scripts/s43-prepare.sh         # crea el hydra inofensivo y el scope de prueba, e imprime los prompts
```

Lanzá con lo que imprime el kit (incluye `MOSH_CONNECTION=orca` y el `PATH` con el binario de prueba):

```bash
MOSH_CONNECTION=orca PATH=/tmp/bounty-bin:$PATH bin/gentle-bounty lab-s43
```

Dentro de la sesión, pegá el prompt que imprime el kit. El alcance va con ruta **absoluta**
(`/home/opencode-agent/GentleBounty/gentle-bounty/work/lab-s43/scope.yaml`) porque el cwd de la sesión
es `work/lab-s43`, y el puerto sale de `.lab/port`, nunca escrito a mano. Vos confirmás el alcance:
no le pidas al agente que lo confirme.

Pi va a mostrar el diálogo de confirmación. Respondé **No** y comprobá que
`/tmp/hydra-ran.marker` no existe y que `work/lab/status.md` dice que quedó pedido. Repetí
respondiendo **Sí** y comprobá que el marcador aparece.

Lo que hay que mirar: el diálogo aparece **una** vez, con el motivo (`brute-force`), y la respuesta
se respeta.
