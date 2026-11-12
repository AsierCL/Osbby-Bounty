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

## 4. CVSS v4.0: cerrado, con dos límites (S55: no se reabre sin fuente nueva)

> **Segundo anclaje real-world: no disponible hoy por falta de adopción de NVD.** La validación
> descansa en la tabla oficial de 270 entradas + invariantes (monotonicidad, interpolación) +
> extremos 10.0/0.0.
>
> Marcado como **deuda, no bloqueante**. No se reabre sin una fuente nueva y confirmada. Las guías
> que publican "worked examples" de CVSS v4.0 para CVE famosos suelen autodeclararse
> "analyst-computed, no es documentación oficial de FIRST.org": no son anclajes válidos aunque se vean
> confiables. Cuatro consultas a la API oficial de NVD (`docs/evidence/nvd/`) no devolvieron ninguna
> entrada `cvssMetricV40`, así que el hueco es de adopción, no de implementación.

Implementado y calculando (S42). Límites conocidos, no deuda de cálculo:

- **Métricas modificadas (`M*`) no soportadas**: se rechazan con error en vez de ignorarlas, porque
  ignorarlas cambiaría el score en silencio. Si un programa exige vectores ambientales, hay que
  portarlas.
- **Cobertura de vectores publicados**: los anclajes son los que fija la especificación (0.0 sin
  impacto, 10.0 máximo) más el vector base de Log4Shell (9.3) y las invariantes del algoritmo. Un
  segundo anclaje de CVE real **no está disponible** (ver el recuadro de arriba): deuda cerrada por
  decisión, no pendiente de trabajo.

## 5. Atafetas de test en la extensión (S43, cerrado en lo mecánico por S47)

`GENTLE_BOUNTY_ALLOW_CONFIRM_STUB=1` + `GENTLE_BOUNTY_CONFIRM_TEST=yes|no` permiten responder la
confirmación sin humano, y `GENTLE_BOUNTY_PRELOAD_SCOPE` carga un scope sin pausa.

Desde S47 esto **no puede pasar en el camino normal**: el scope exige `lab: true|false`, el stub solo
responde con `lab: true`, y un alcance real con el stub activo **se niega a cargar** dejando el error
en `status.md`. Queda como atafeta de verificación, con dos variables y log en cada uso.
