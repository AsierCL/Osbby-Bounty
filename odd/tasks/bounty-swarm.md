# gentle-bounty — enjambre, pizarra y enriquecimiento (macrocambio)

Feature: pasar de un agente que caza solo a un enjambre coordinado, sin abrir ninguna vía de red
nueva. Repo: `/home/opencode-agent/GentleBounty/gentle-bounty`. Plan vigente: `docs/PLAN.md`.
Rama: `feat/bounty-swarm`.

## Specs

Normativas. Citan el pedido del usuario y el material pegado; no se resumen ni se amplían.

### S1 — Qué se quiere construir

```
Para hacer bugbounty automático con IA, cuales deberían ser las fases? Que debería hacer mi harness
en cada fase? Que herramientas, MCPs , skills o habilidades debería tener?
```

### S2 — La topología deseada

```
Mi idea inicial es tener un agente orquestrador principal, que spawnee los subagentes que necesite.
No me importaria que para la misma tarea spawnee 5 o 6 si eso implica mejores resultados y trabajo
complementario
```

### S3 — Coordinación buscada

```
Diseña la implementación en código del Blackboard compartido (por ejemplo con Redis o estado en
memoria) y el proxy HTTP con deduplicación y rate-limiting para coordinar los subagentes.
```

### S4 — Autoridad para adaptar el material

```
El codigo que ha pasado es susceptible de ser modificado o adaptado para nuestro proyecto.
```

### S5 — Motor decidido por el humano

```
Nativo Pi + board en filesystem: extiende runner.ts y el patrón de locks que ya usa el repo.
Un solo runtime, el gate sigue siendo el único chokepoint.
```

### S6 — Alcance del primer corte

```
Todo, planificado de una vez: documento de feature con las 5 capas, tasks y commits por unidad.
Commits por capa, verificación por capa.
```

### S7 — Worktree previo

```
Mergear sus docs a main: es 1 commit de documentación de evidencia real; suma contexto y evita
divergencia.
```

### S8 — Restricciones que no se reabren

De `docs/PLAN.md`, sección "No se hace". Un segundo runtime, Redis/Neo4j, caché in-flight en el proxy
y consenso multi-modelo quedan fuera: el gate en TypeScript es el único chokepoint (`ADR-0004`,
`Anexo A`).

## Tasks

| ID | Spec | Route | Entrega | Commit |
|---|---|---|---|---|
| T1 | S1-S6 | inline | `docs/PLAN.md` reconciliado; este documento | `docs: ...` |
| T2 | S3, S5 | inline | `src/core/board.ts` + `tests/board.test.ts` | `feat: ...` |
| T3 | S2, S5 | worker | `src/pi/swarm.ts` + `bounty_swarm` + 4 roles en `assets/agents/` | `feat: ...` |
| T4 | S1, S3 | worker | `bounty_surface` (JS / OpenAPI / GraphQL → board) | `feat: ...` |
| T5 | S1 | worker | `bounty_session` (matriz de roles sin credenciales en argv) | `feat: ...` |
| T6 | S1 | worker | recon como job con estado persistido y consulta | `feat: ...` |

## Log

### L1 — pedido original (verbatim)

```
Hola. Estas trabajando en este directorio de trabajo. En el tienes toda la suite de gentle AI, y una
modificacion propia llamada gentle-bounty.
Analizala, revisala, ya que le quiero hacer un macrocambio. Te paso la conversación que he tenido con
una IA potente para que miremos de todo lo que ha dicho que vamos a implementar y como. El codigo que
ha pasado es susceptible de ser modificado o adaptado para nuestro proyecto.
```

### L2 — revisión (hallazgos que cambian el plan)

- `PLAN-MAESTRO-gentle-bounty.md` (fuera del repo) declara "nada implementado" y es falso: 409 tests
  verdes, gate, limiter compartido, cadena de evidencia, verificador firmado, CVSS v4.0 y reporte ya
  están hechos. Se reemplaza por `docs/PLAN.md` dentro del repo.
- Lo que falta de verdad: enriquecimiento (JS/esquemas), matriz de roles, enjambre y pizarra.
- El diseño pegado asume pub/sub vivo (Redis). Los hijos son procesos `pi` separados sin canal: la
  pizarra es filesystem + pull, como `shared-ratelimit.ts` y `evidence.ts`.
- El diseño pegado asume cliente HTTP propio; acá las tools son CLIs. Se deduplica trabajo, no
  requests.
- Riesgo nuevo no cubierto por el material: 6 workers no mejoran throughput (rate compartido), sí
  duplican trabajo sin claim/lease, y multiplican superficie de inyección y presupuesto.

### L3 — decisiones del humano

- S5: motor nativo Pi, board en filesystem.
- S6: las 5 capas planificadas en un documento, commits por capa.
- S7: mergear `wip-verifier` a `main` antes de empezar (hecho: `94d1268`, merge sin conflictos;
  suite verde después del merge).
