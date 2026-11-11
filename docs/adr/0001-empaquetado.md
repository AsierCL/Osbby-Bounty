# ADR-0001 — Empaquetado de gentle-bounty respecto de gentle-pi

- **Estado**: aceptado (Fase A, checkpoint 1)
- **Fecha**: 2026-11-11
- **Decide**: cómo se empaqueta `gentle-bounty` para no copiar el motor de `gentle-pi`
- **Specs**: S15 (`NO forkees todavía`), S16 (Fase A + entregable ADR), S3 (terceros solo lectura)

## Contexto

`gentle-bounty` tiene que dar cinco tools de dominio, subagentes con allowlist de tools, un
protocolo de 7 fases y skills, sobre Pi. El plan v1 asumía un fork de `gentle-pi`; C8 lo prohíbe
hasta cerrar este spike. La pregunta operativa es una sola:

> ¿Puede `gentle-bounty` ser un paquete Pi independiente que conviva con `gentle-pi`/`gentle-ai`
> sin copiar su motor?

Método: lectura estática de la documentación de Pi 1.5.2 y del paquete `gentle-pi@4.7.0`
instalados en el host. Cero red, cero ejecución de código de terceros (S1, S3). Todo lo que no se
pudo comprobar por lectura está en la sección NO VERIFICADO.

## Hallazgos

**F1 — Un paquete Pi es un directorio con manifiesto declarativo.** `package.json` puede declarar
`pi.extensions`, `pi.skills`, `pi.prompts`, `pi.themes`, o dejar que Pi descubra los directorios
convencionales (`docs/packages.md:46-92`). No hace falta tocar Pi para publicar un paquete.

**F2 — Los recursos de un paquete se pueden filtrar por scope, incluido por archivo.**
`packages.md:118-135` admite `{"source": "...", "extensions": ["+path", "-path"]}`, y
`packages.md:149` establece que *"a project entry normally replaces the personal entry"*. Es decir:
un workspace de bounty puede desactivar `gentle-pi` sin desinstalarlo.

**F3 — Cada archivo de extensión es una unidad independiente.** Una extensión es
`export default function (pi: ExtensionAPI)` (`docs/extensions.md:76`, y lo mismo en
`:193,:222,:1189,...`). El filtrado por archivo de F2 opera a este nivel, no a nivel de módulo
interno.

**F4 — La composición de prompt entre extensiones es posible y aditiva.** `before_agent_start`
recibe `event.systemPrompt` como *"current chained system prompt for this handler (includes changes
from earlier before_agent_start handlers)"* (`docs/extensions.md:637-690`). Técnicamente dos
extensiones pueden convivir y ambas aportar prompt. Esto descarta el argumento "es imposible
técnicamente" y lo reemplaza por un problema de diseño: dos protocolos en un mismo prompt.

**F5 — Pi NO tiene sistema de subagentes.** Los subagentes los registra `gentle-pi`:
`extensions/gentle-agents.ts:136` define `TOOL_PREFIX = "subagent_"` y `:2622-2623` registra
`name: ${TOOL_PREFIX}${name}` en loop; `:402` registra `subagent_parent_message`; `:2753-2935`
registran los `orchestrator_*`. La propia documentación de Pi presenta `subagent/` como un ejemplo
de capacidad *que aporta una extensión* (`docs/extensions.md:3346`). Consecuencia: si queremos
subagentes, o los provee `gentle-pi`, o los implementamos nosotros.

**F6 — La capa de subagentes de `gentle-pi` es un módulo grande y acoplado a su harness dev.**
`extensions/gentle-agents.ts` (3.342 líneas) no importa `gentle-ai.ts` (verificado por grep: sin
coincidencias), pero arrastra `lib/agents-runner.ts` (1.545), `agents-protocol.ts` (722),
`agents-session-transport.ts` (786), `agents-view.ts` (971), `agents-widget.ts` (455),
`session-profile-*.ts` (~1.928) y `#{lib}` completo: 249 archivos, 3.8 MB. Además registra
`orchestrator_*` y estado de receipts de review (`lib/review-reminder-receipt.ts`), que asumen el
harness de desarrollo completo.

**F7 — Los subagentes de `gentle-pi` son procesos `pi` hijos.** Inyecta `spawn` en
`gentle-agents.ts:306` y `pi: piCommand()`; los hijos cargan extensiones de contexto acotadas
(`childContextExtensionPaths`, `:220`). O sea, el orquestador no es magia in-process: es
`spawn` + protocolo.

**F8 — Pi expone exactamente las primitivas para un runner propio y restringido.**
`-t/--tools <list>` con allowlist exacta (`docs/cli.md:121`), `-nt/--no-tools` (`:127`),
`--exclude-tools 'mcp__*'` y `--no-mcp` (`:140`, `:200`), `-ne/--no-extensions` (`:198`),
`--mode json|rpc|text` (`:48-50`). El ejemplo oficial es literalmente
`pi --tools read,grep,find,ls --print "Review this project"` (`:116`).

**F9 — Depender de `npm:gentle-pi` trae 16.829 líneas y un `postinstall`.**
`gentle-shell/package.json:45` declara `"postinstall": "node scripts/install-gentle-ai.mjs"` y
`:74` una dependencia de runtime (`@heyhuynhgiabuu/pi-pretty`). Un paquete Pi del que dependemos
debe publicarse dentro del tarball (`docs/packages.md:114`). Matiz relevante: *"Local packages are
not installed or modified"* (`docs/packages.md:100-114`), así que un `postinstall` de terceros solo
corre con fuentes npm/git, no con path local.

**F10 — Forkear cuesta F0 más merges eternos.** La persona está en un literal TS
(`gentle-ai.ts:1602`), el protocolo ODD en un asset con verificación fail-closed
(`ODD_PROTOCOL_HEADING`, `gentle-ai.ts:1533`) y el contrato RDD en un mirror verificado por digest
(`gentle-ai.ts:1530-1590`). `gentle-ai.ts` son 13.487 líneas: llevarlo a un fork significa o
duplicarlo, o hacer el refactor F0 y sostener merges de upstream para siempre.

## Opciones

| | A — Paquete aparte, sin `gentle-pi`, runner propio | B — Paquete que depende de `npm:gentle-pi` y filtra recursos | C — Fork con F0 |
|---|---|---|---|
| Copia el motor | no | no | sí (o refactor F0) |
| Subagentes | propios (~300-400 líneas sobre F8) | los de `gentle-pi` (F5, F6) | los de `gentle-pi` |
| Prompt | solo el bounty | chained: bounty + harness dev completo (F4) | editable, un solo dominio |
| Superficie de dependencia | ~0 | 3.8 MB lib + 13.5k líneas + `postinstall` npm (F9) | repo propio de 16.8k líneas |
| Riesgo de rotura por release de terceros | bajo | alto: depende de la ruta interna `extensions/gentle-agents.ts` (F2/F3) | nulo, y a la vez aislamiento total |
| Coste de mantenimiento | runner propio acotado | bajo al principio, alto cuando `gentle-pi` refactorice archivos | el más alto: F0 + merges (F10) |
| Cumple S3 (no correr instaladores) | sí | sí solo con path local; **no** con fuente npm (F9) | sí |
| Cumple C1 (núcleo sin Pi) | sí, el núcleo no depende de nada | sí | sí |

## Decisión

**Opción A: `gentle-bounty` es un paquete Pi independiente que no depende de `gentle-pi` ni de
`gentle-ai`, con runner de subagentes propio y mínimo.**

Razones, en orden de peso:

1. **S3 y F9.** Depender de `npm:gentle-pi` mete un `postinstall` que instala otro binario en el
   host. Aceptable solo como path local, y eso degrada la reproducibilidad de la herramienta.
2. **F6.** El 95% de la capa de subagentes de `gentle-pi` existe para servir su harness de
   desarrollo (perfiles de modelo, sidebar, receipts de review, jobs). Bounty necesita spawn +
   allowlist + devolver resultado: F8 demuestra que Pi ya lo da.
3. **F4.** La convivencia técnica es posible pero indeseable: dos protocolos (ODD dev, TDD, RDD) en
   el mismo prompt compiten con el protocolo de bounty. Un dominio por sesión.
4. **C8.** Forkear ahora contradice la instrucción y multiplica el coste (F10) sin haber probado
   nada del dominio.

**Convivencia**: `gentle-bounty` no se carga junto a `gentle-pi` en la misma sesión. Los workspaces
de bounty desactivan `gentle-pi` con un `.pi/settings.json` de proyecto (F2). Es un paso
documentado del usuario, no algo que este repo automatice.

## Consecuencias

- **Se implementa en este repo**: 5 tools de dominio (`bounty_scope`, `bounty_run`,
  `bounty_evidence`, `bounty_finding`, `bounty_phase`), runner de subagentes, assets del protocolo,
  skills, y el núcleo `bounty-core` sin dependencias (S8).
- **Se pierde gratis**: review RDD, `gentle_odd_phase`, sidebar de agentes, jobs en background,
  personas conmutable. Si alguno resulta indispensable, se reevalúa — no se reimplementa por reflejo.
- **Fase D crece**: el runner es trabajo nuevo. Estimación por líneas de una implementación mínima
  (spawn + argv + parseo de `--mode json` + timeout + kill de árbol): 300-400 líneas + tests.
  **NO VERIFICADO** como medida real: es una estimación estructural, no un cronómetro.
- **Cero deps de runtime** en el repo: `node --experimental-strip-types` + `node:test` cubren TS y
  tests sin instalar nada, coherente con S3.

## Riesgos nuevos que abre esta decisión

| Riesgo | Mitigación |
|---|---|
| Reimplementar orquestación peor que la existente (timeouts, árboles de procesos, resultados perdidos) | Runner mínimo con contrato explícito y tests; nada de features de orquestación que el dominio no pida |
| Dependencia futura de detalles internos de Pi (`--mode json` shape) | Un único módulo `runner.ts` contra el que todo lo demás habla |
| Deriva de comportamiento entre "lo que Pi documenta" y "lo que Pi hace" | El primer test de la Fase D es de contrato: arrancar un hijo con `--no-mcp --no-extensions -t read` y verificar que no tiene más tools |
| El usuario querrá el review RDD de `gentle-pi` para el código de la herramienta | Se corre `gentle-pi` en el repo de desarrollo de la herramienta (otra sesión), no en el workspace de bounty |

## NO VERIFICADO

1. Que `extensions/gentle-agents.ts` cargue solo, sin `gentle-ai.ts`/`gentle-shell.ts`. No se
   ejecutó: es código de terceros y S3 lo mantiene en solo lectura. Relevante solo para la opción B.
2. Que la combinación `--no-extensions --no-mcp -t <allowlist>` deje realmente al hijo sin vía de
   red. Documentado (`docs/cli.md:116-200`) pero **no ejecutado**. Es el primer test de contrato de
   la Fase D y un prerequisito de la Fase E.
3. El coste real del runner propio (estimación estructural, no medida).
4. Que `node --experimental-strip-types` + `node --test` corran `.ts` sin fricción en este host:
   `node --version` es v22.23.4 y Pi lo declara soportado (`gentle-shell/package.json` engines), pero
   no se ejecutó ningún test todavía. Se valida al abrir la Fase B.
5. Los licenciamientos de los paquetes MCP candidatos de la Fase F.

## Qué haría cambiar esta decisión

- Si la Fase D demuestra que el runner mínimo necesita >800 líneas para ser confiable, la opción B
  vuelve a la mesa (o el fork, con F0).
- Si el usuario pide el review RDD nativo **dentro** de la sesión de bounty, la opción B gana peso.
- Si `gentle-pi` publica su capa de subagentes como paquete propio, A se simplifica: se adopta.
