# Deuda técnica

Registro explícito de lo que se sabe roto o incompleto y **no** se está arreglando ahora, para que
no viva solo en un informe de checkpoint.

## 1. Skills de `gentle-pi` contaminan el contexto de bounty (S46, pospuesto)

Con `-ne` se apagan las **extensiones**, no las **skills** del paquete instalado: la sesión de bounty
sigue viendo el catálogo de skills de desarrollo (branch-pr, judgment-day, skill-creator, …). Las
**tools** sí están restringidas y verificadas; lo que sobra es prompt.

- Riesgo: el agente puede intentar cargar una skill de desarrollo en medio de un programa.
- Mitigación actual: ninguna mecánica; el prompt de dominio no las menciona.
- Arreglo propuesto: filtrar `skills` en el manifiesto del proyecto (`.pi/settings.json` con
  `skills: []` para el paquete) o arrancar con un `--skills` vacío si Pi lo permite.
- No bloqueante para cargar un programa real.

## 2. Host en valor de wordlist no se valida (S44, documentado en docs/gate.md)

Ver la sección "Hueco conocido: wordlists" en `docs/gate.md`. Decisión pendiente: ¿se valida también
ese valor cuando parsea como URL (`https://…`), como ya se hace con `-o`/`-t`/`-w`?

## 3. Pausa destructiva: falta la tecla (S43)

El mecanismo está verificado con proceso real y con la firma documentada de `ctx.ui.confirm`; lo que
falta verificar es el diálogo de Pi y la tecla del humano. Detalle, intentos fallidos y procedimiento
manual: `docs/evidence/confirm-live.md`.

## 4. CVSS v4.0 no calcula (S42, bloqueado por decisión)

`src/core/report.ts` valida la forma del vector y transporta un score puesto a mano. El cálculo
oficial requiere la tabla de lookup de MacroVectores de la especificación v4.0, que no está en este
repo ni en el host. Opciones: usar los datos de referencia oficiales de FIRST (repo **no** listado en
Fase F, licencia BSD-2, con registro de licencia) o que el humano aporte los vectores de referencia.
Pendiente de decisión. **Es el único punto que impide un reporte con severidad defendible.**

## 5. Atafetas de test en la extensión (S43)

`GENTLE_BOUNTY_ALLOW_CONFIRM_STUB=1` + `GENTLE_BOUNTY_CONFIRM_TEST=yes|no` permiten responder la
confirmación sin humano, y `GENTLE_BOUNTY_PRELOAD_SCOPE` carga un scope sin pausa. Son **solo para
verificación**: la extensión loguea cada respuesta por stub, y **nunca se activan contra un programa
real**. Con las dos variables ausentes, la sesión pregunta por la UI y, si no hay UI, responde "no".
