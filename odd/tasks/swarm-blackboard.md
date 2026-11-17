# gentle-bounty — swarm + blackboard (macrocambio ODD, 4 unidades)

Feature: pizarra compartida canónica, caché de lecturas, enjambre con perfiles ortogonales y cierre de
la deuda S46/S60. Repo: `/home/opencode-agent/GentleBounty/gentle-bounty`. Rama: `feat/bounty-swarm`.

## Specs

Normativas. Transcriben el pedido del usuario sin resumir; no se amplían.

### S1 — Pizarra sobre filesystem, patrón de concurrencia copiado

```
Crear src/core/blackboard.ts replicando exactamente el patrón de concurrencia entre procesos de
src/core/shared-ratelimit.ts: persistencia atómica en work/<program>/blackboard.json (mediante
escritura en archivo temporal .tmp + rename) serializada con un lockfile work/<program>/.blackboard.lock
(con open(lockPath, "wx"), TIMEOUT_MS = 5000, STALE_MS = 10000 y RETRY_MS = 5).
```

### S2 — Interfaz BlackboardArtifact

```
id: string (los primeros 16 caracteres del hash SHA-256 determinista calculado sobre
category + "|" + target + "|" + canonicalJson(data)).
category: "endpoint" | "hidden_param" | "auth_schema" | "header_anomaly" | "tech_fingerprint" | "state_invariant".
target: string (URL o host normalizado).
data: Record<string, unknown> (claves ordenadas lexicográficamente al calcular el fingerprint).
discoveredBy: string (sessionId o rol del agente).
ts: string (ISO timestamp).
```

### S3 — createSharedBlackboard

```
Exponer createSharedBlackboard({ dir, clock? }) con los métodos:
publish(input): si el id (fingerprint) ya existe en blackboard.json, devuelve
{ created: false, artifact: existing } sin duplicar. Si es nuevo, lo guarda y devuelve
{ created: true, artifact }.
query(filter?: { category?: BlackboardCategory; target?: string; limit?: number }): devuelve la lista
de artefactos filtrados ordenados por ts ascendente.
```

### S4 — Integración y trazabilidad

```
Integrar en src/pi/session.ts y registrar la tool bounty_blackboard en extensions/bounty.ts
(soportando action: "publish" | "query"). Cuando action === "publish" cree un artefacto nuevo
(created: true), además debe registrar automáticamente una entrada de tipo "recon-note" (o
"observation") en el evidence.ts del programa para mantener la trazabilidad en la cadena de custodia.
```

### S5 — Visible para los hijos

```
Añadir "bounty_blackboard" a ALLOWED_CHILD_TOOLS en src/pi/runner.ts para que los subagentes puedan usarla.
```

### S6 — Firma de request cacheable

```
Implementar un módulo src/core/request-cache.ts (o integrarlo directamente en proxy.ts / session.ts)
que calcule una firma determinista SHA256(method.toUpperCase() + "|" + normalizedUrl + "|" + authContext)
para peticiones idempotentes de solo lectura (GET, HEAD, OPTIONS).
```

### S7 — Coalescencia in-flight y caché TTL compartida

```
Soportar dos mecanismos:
Coalescencia In-Flight (en memoria): si una petición con la misma firma está actualmente en curso
dentro del mismo proceso, las llamadas concurrentes esperan la misma Promise en lugar de abrir una
segunda conexión o lanzar un segundo subproceso.
Caché TTL compartida (work/<program>/.http-cache.json o en el proxy): almacenar respuestas exitosas
(2xx, 3xx, 401, 403) durante un ttlMs configurable (por defecto 60_000 ms). Si una petición idempotente
hace hit en caché vigente, devolver el resultado marcando en las notas/metadatos cacheHit: true sin
descontar presupuesto ni tokens del SharedLimiter.
```

### S8 — Bypass y regla del verificador

```
Permitir un flag explícito bypassCache?: boolean para los casos donde bounty_verify o pruebas de
condición de carrera (burst) necesiten forzar tráfico real hacia el objetivo. Regla crítica: el
verificador (bounty_verify) SIEMPRE debe ejecutarse con bypassCache: true para que sus 2
reproducciones sean tráfico real contra el objetivo y nunca lean de caché.
```

### S9 — Cuatro perfiles ortogonales

```
Crear en assets/agents/ cuatro perfiles especializados nuevos (con su frontmatter name, description y
tools restringidos exclusivamente a ALLOWED_CHILD_TOOLS, incluyendo bounty_blackboard):
bounty-js-analyzer.md, bounty-authz.md, bounty-schema.md, bounty-headers-config.md.
```

### S10 — runSwarm

```
Recibe target (que primero debe pasar por gate.ts / scope.ts antes de spawnear ningún hijo), una lista
de roles (por defecto los 4 especialistas o un subconjunto), concurrency máxima de procesos pi
simultáneos (por defecto 3, tope 6), y un perAgentBudget (src/pi/budget.ts).
Antes de lanzar cada hijo, inyecta en el prompt de tarea el snapshot actual relevante de
blackboard.query({ target }).
Ejecuta los hijos con un semáforo de concurrencia, recolectando para cada rol: ok, sessionId,
invocationToken, toolCalls, artefactos nuevos publicados en el blackboard y findings candidatos creados.
Si un hijo falla o alcanza timeout/budget, runSwarm no aborta a los demás (Promise.allSettled).
```

### S11 — Sin recursión

```
Registrar la tool bounty_swarm en extensions/bounty.ts (solo disponible para el orquestador padre, NO
incluir bounty_swarm dentro de ALLOWED_CHILD_TOOLS en runner.ts para impedir recursión infinita donde
un subagente spawnee otro enjambre).
```

### S12 — Fan-in

```
Al finalizar el Fan-In de bounty_swarm, actualizar work/<program>/status.md con el resumen de la
corrida del enjambre y devolver al orquestador los artefactos nuevos del Blackboard y los IDs de
cualquier finding en estado candidate para que el siguiente paso sea invocar bounty_verify.
```

### S13 — Aislamiento de prompt

```
Revisar bin/gentle-bounty.mjs y extensions/bounty.ts para asegurar que la sesión principal de
gentle-bounty tampoco cargue las skills de desarrollo de gentle-pi (-ns o configuración explícita) y
que el prompt de dominio (assets/identity.md + assets/protocol.md) documente el uso de bounty_blackboard
y bounty_swarm.
```

### S14 — Documentación

```
Actualizar README.md, docs/USO.md y docs/DEUDA.md reflejando las nuevas tools y marcando los puntos
resueltos.
```

## Decisiones de implementación

- **D1 (T1): una sola pizarra.** `src/core/board.ts` (creado en el macrocambio anterior) se migra a
  `src/core/blackboard.ts`, que pasa a ser el store canónico con el contrato S2-S3. La tool
  `bounty_board` se renombra a `bounty_blackboard`. Dos stores con archivos distintos serían dos
  verdades: se descarta.
- **D2 (T1): `claim`/`release`/`since` se conservan** como métodos adicionales del blackboard, porque
  el enjambre y el protocolo ya los usan; el contrato pedido (publish/query) queda idéntico.
- **D3 (T1): el programa es parte del estado.** El archivo guarda `program` y publish/query rechazan
  pedidos de otro programa: es el "rechazo si el programa no coincide con GENTLE_BOUNTY_PROGRAM" de
  los tests, verificado en el core y no solo en el adaptador de Pi.
- **D4 (T2): el verificador no comparte la caché de la sesión.** `bounty_verify` corre con
  `bypassCache: true` fijo en el código, no como parámetro que el modelo pueda olvidar.
- **D5 (T2): cache hit no firma ejecución.** Una respuesta de caché se registra como
  `cache-note`/`cacheHit: true`; no produce un registro `execution` firmado, así que no puede
  confundirse con una reproducción real.

## Tasks

| ID | Specs | Entrega | Commit |
|---|---|---|---|
| T1 | S1-S5, D1-D3 | `src/core/blackboard.ts`, tool `bounty_blackboard`, evidencia `recon-note`, allowlist de hijos, `tests/blackboard.test.ts` | `feat(blackboard): ...` |
| T2 | S6-S8, D4-D5 | `src/core/request-cache.ts`, integración en `session.run`, `bypassCache` del verificador, `tests/request-cache.test.ts` | `feat(cache): ...` |
| T3 | S9-S12 | 4 perfiles en `assets/agents/`, `src/pi/swarm.ts` con gate previo, snapshot y fan-in, `tests/swarm.test.ts` | `feat(swarm): ...` |
| T4 | S13-S14 | `-ns` verificado, prompt de dominio, README/USO/DEUDA | `docs: ...` |

## Log

### L1 — pedido original (verbatim, instrucción)

```
Quiero que clasifiques este trabajo como large en ODD (creando odd/tasks/swarm-blackboard.md, su espejo
en Engram si está disponible y la lista todo), y que ejecutes las siguientes 4 unidades de trabajo en
orden, cerrando cada una con su commit de unidad de trabajo: Tarea 1 (T1) ... Tarea 4 (T4) ...
Arrancá por la fase de exploración/planificación ODD, creá el documento de tareas en
odd/tasks/swarm-blackboard.md y empezá la implementación por T1.
```

Las cuatro tareas y sus specs S1-S14 están transcriptas arriba sin resumir.

### L2 — decisión de arquitectura (D1)

La pizarra ya estaba implementada como `src/core/board.ts` + `bounty_board` (25 tests, commit
`fc16776`/`fb7ab20`). Se migra al nombre y contrato pedidos en vez de crear un segundo store.

### L3 — Engram

El espejo no se pudo escribir: `missing or unavailable contract (HTTP 404)`, esperado
`engram.pi-http-runtime/v1`. Deuda declarada en `docs/DEUDA.md`; el repo es la fuente.

### L9 — Engram portable en Docker

- `engram/portable/`: compose (runtime local `serve`, `network_mode: host`, `restart: "no"`), volumen
  `data/`, script `bin/engram-portable` (up/down/status/logs/cli) y shim `bin/engram` para el host.
- Diagnóstico: el 404 era un `engram serve` 3.4.0 viejo en 7437, sin `/runtime-contract`; el plugin
  necesita ese endpoint y falla cerrado.
- Verificado: `/health` 200, `/runtime-contract` 200, `POST /sessions` 201, `POST /observations` 201 y
  la observación sobrevive a `down`/`up`.
- El espejo de este documento y el de `docs/DEUDA.md` siguen pendientes de Pi: este proceso cargó el
  entorno al arrancar y compara contra el binario 3.4.0. Se escribe en la próxima sesión con
  `ENGRAM_URL` o `ENGRAM_BIN` exportados.
