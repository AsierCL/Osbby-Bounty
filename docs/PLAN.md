# Plan vigente: enjambre y enriquecimiento

Reemplaza al `PLAN-MAESTRO-gentle-bounty.md` que vive fuera del repo (ese documento dice "nada está
implementado" y hoy es falso). Este es el estado real y lo que falta. Se actualiza con evidencia, no
con intención.

## Qué existe y está verificado

`npm test` → 409 tests, sin red. Detalle por capacidad en `docs/GO-NO-GO.md`.

| Capa | Implementación |
|---|---|
| Alcance | `src/core/scope.ts`, `src/core/gate.ts` (argv completo, `Host:`, CNAME, DNS, IPs privadas, `unknown` falla cerrado), `bin/gentle-bounty --preflight` |
| Ritmo | `src/core/ratelimit.ts` + `src/core/shared-ratelimit.ts` (token bucket por host, por programa, compartido entre procesos con lock) |
| Egreso | `src/core/proxy.ts` (mismo matcher y mismo limiter que el gate) |
| Evidencia | `src/core/evidence.ts` (append-only, hash-chained, lock serializado, head atómico) |
| Hallazgos | `src/core/findings.ts`, `src/core/pending.ts`, `src/core/verdict.ts` |
| Severidad y reporte | `src/core/cvss.ts` + `cvss-data.ts`, `src/core/report.ts` |
| Independencia | `src/pi/verifier.ts` (sin el razonamiento del autor, ejecuciones firmadas, `INCONCLUSO`) |
| Aislamiento | `src/pi/runner.ts`, `bin/gentle-bounty.mjs` (sesión principal sin bash/fetch/write, subagentes con allowlist) |

Conclusión: el control (fases 1, 5 y 6 del diseño de referencia) está resuelto y no se toca. Lo que
falta es **cobertura** (fases 3 y 4) y **coordinación** (enjambre y pizarra).

## Qué falta, por capa

### Capa 0 — Este documento

El plan externo está desfasado. La verdad operativa son `docs/GO-NO-GO.md`, `docs/DEUDA.md` y este
archivo.

### Capa 1 — Pizarra (`src/core/board.ts`)

Estado de descubrimientos compartido entre procesos del mismo programa. **No** es pub/sub: los hijos
son procesos `pi` separados (`src/pi/runner.ts`), sin canal vivo. Es **filesystem + pull**, el mismo
patrón que ya resuelven `shared-ratelimit.ts` y `evidence.ts`.

Contrato:

- `publish({kind, target, data, by})` → idempotente por `fingerprint` (`kind|target|data` canónico).
- `claim(seq, {by, ttlMs})` / `release(seq, by)` → lease con vencimiento; un claim vencido es robable.
- `since(seq)` / `query({kind, target})` → lectura acotada, para podar contexto.
- `state()` → `{count, headSeq}` para `status.md`.

Reglas: `by` obligatorio (todo descubrimiento tiene autor); el log es append-only y una línea
malformada es un error, no un registro a saltear (saltear duplicaría trabajo).

### Capa 2 — Enjambre (`bounty_swarm`)

Fan-out sobre el `runner.ts` existente, sin ampliar su allowlist:

```
bounty_swarm { program, roles: [...], maxParallel, budgetPerRole }
```

- Cada rol es un `assets/agents/<rol>.md` con tools de `ALLOWED_CHILD_TOOLS`.
- Fan-in: los hijos publican en el board; el padre agrega con un crítico que solo ve artefactos.
- Presupuesto: por rol (`budget.ts`) **y** agregado por programa; el actual es por proceso.
- Roles nuevos: `authz-matrix`, `js-analyst`, `schema-auditor`, `skeptic`.

Regla de diseño: **paralelizar cognición, serializar red**. El fan-out rinde sobre datos ya capturados
(JS, esquemas, respuestas), no sobre tráfico: el rate es del programa y no se multiplica.

### Capa 3 — Enriquecimiento

- `bounty_surface`: ingesta de bundles JS, OpenAPI/Swagger y esquemas GraphQL → catálogo de endpoints
  en el board, con parámetros y origen.
- `bounty_session`: matriz de roles (A / B / anónimo / admin) con headers por rol desde
  `.bounty/config.json`. Credenciales nunca en argv (regla ya escrita en el protocolo).

Es el hueco funcional más grande: sin esto se audita a ciegas.

### Capa 4 — Jobs

`bounty_recon` bloquea la sesión hasta terminar subfinder+httpx (`session.ts`, `reconPipeline`). Pasa
a job con estado persistido y consulta posterior. La cadena de evidencia ya lo soporta.

## Riesgos propios del enjambre

1. **Latencia**: el rate se comparte, el throughput del target no mejora. Seis workers tardan lo mismo
   para la misma cantidad de requests.
2. **Duplicación**: sin `claim/lease` dos agentes piden lo mismo y transicionan el mismo hallazgo.
3. **Presupuesto**: 500 llamadas por proceso × N hijos. Falta techo agregado.
4. **Inyección**: N hijos leyendo HTML/JS crudo multiplica la superficie. Poda en el borde de
   `bounty_run`, como mecanismo, no como skill.
5. **Reporte**: lo escribe un solo rol, después del fan-in. N escritores = N estilos.

## No se hace

- **Runtime Python / LangGraph**: parte el chokepoint en dos lenguajes y abre una vía de red que el
  gate no ve (`Anexo A` del plan viejo, `ADR-0004`).
- **Redis / Neo4j**: host único y árbol de procesos único; los locks de archivo ya resuelven. Si
  aparece dolor de consulta, el paso es SQLite sobre `findings/` y `board/`.
- **Caché y coalescencia in-flight en el proxy**: no hay cliente HTTP interno; las tools hacen su
  propio HTTP. Contamina la evidencia (una respuesta cacheada no es una observación del momento). Se
  deduplica **trabajo**, no requests.
- **Consenso multi-modelo**: la autoridad es la reproducción firmada, no el acuerdo entre modelos.
- **MCP de escaneo en el camino crítico** (`D12`): solo observar/interceptar.

## Orden

| Unidad | Contenido | Criterio de aceptación | Estado |
|---|---|---|---|
| U1 | Capa 0: este documento | el plan externo queda marcado como superado | hecho |
| U2 | Capa 1: `board.ts` | publish idempotente, claims con lease, concurrencia multi-proceso sin pérdida, línea corrupta rechazada | hecho (15 tests) |
| U3 | Capa 2: `bounty_swarm` + 4 roles | fan-out con presupuesto por rol y agregado; el padre agrega sin ver el razonamiento de los hijos | hecho (16 tests + `bounty_board`) |
| U4 | Capa 3: `bounty_surface` | un bundle real produce endpoints en el board, con dedupe | hecho (11 tests) |
| U5 | Capa 3: `bounty_session` | matriz de roles sin credenciales en argv | hecho (10 tests; archivo plano 0600) |
| U6 | Capa 4: recon como job | la sesión no queda bloqueada; el job se consulta y se reanuda | pendiente |

Estado a hoy: U1-U5 entregadas con tests y commits por unidad en `feat/bounty-swarm`. `bounty_board`
ya está disponible para el orquestador y para los hijos (allowlist de `runner.ts` y de
`bin/gentle-bounty.mjs`).

Cada unidad: commit de unidad de trabajo, tests junto al comportamiento, doc actualizada.
