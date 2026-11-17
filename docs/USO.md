# Cómo se usa gentle-bounty

Una página y media, en castellano llano. Si algo acá no se entiende, el problema es del documento.

## Qué es

Una capa de control para hacer bug bounty con un agente. No escanea nada por su cuenta: decide **qué
se puede tocar**, **a qué ritmo**, lo **registra** y guarda **evidencia** que se puede defender.

Dos líneas rojas, y solo dos:

1. Nunca se toca nada fuera del alcance del programa.
2. Nunca se hace fuerza bruta, DoS ni nada destructivo sin que vos digas que sí.

## Arrancar

```bash
bin/gentle-bounty acme
```

Eso abre una sesión de Pi restringida: sin `bash`, sin búsqueda web, sin escritura de archivos, sin
MCP (salvo que vos los habilites con `GENTLE_BOUNTY_MCP=`). La sesión arranca parada en
`work/acme/`.

Antes de arrancar en serio, podés ver exactamente qué se va a ejecutar, sin lanzar nada:

```bash
bin/gentle-bounty acme --check
```

Y podés revisar el alcance **sin abrir sesión**: imprime el mismo resumen interpretado que
`bounty_scope`, más avisos legibles (wildcard que cubre todos los puertos, falta de `out_of_scope`,
ritmo ausente o alto, `lab: false` con fecha de autorización ausente o futura). Es de solo lectura y no
toca la red:

```bash
bin/gentle-bounty --preflight acme
```

La sesión arranca **sin el catálogo de skills** de tu Pi (`-ns`): las instrucciones de bounty son las
del paquete, y nada más. También los subagentes.

## Autonomía y paradas

El agente resuelve solo lo que es problema de la herramienta (sintaxis, rutas, binarios, cómo invocar
algo) y **para a preguntar** ante tres obstáculos: un mecanismo de protección del objetivo (anti-bot,
captcha, WAF, rate-limiting real), la necesidad de escribir un secreto en un lugar permanente como la
cadena de evidencia, o cualquier cambio al gate, al runner o a las reglas de alcance — eso se hace en otra
sesión, con revisión humana.

## Tres veredictos, y ninguno miente

El verificador independiente no dice "lo vi" o "no lo vi" nada más:

- **REPRODUCIDO** ⇒ el hallazgo pasa a `verified`.
- **NO_REPRODUCIDO** ⇒ si estaba `candidate`, pasa a `rejected`; si estaba `verified`, pasa a
  **`disputed`**, que resolvés vos. El código nunca degrada solo un hallazgo verificado.
- **INCONCLUSO** ⇒ el hallazgo **no se mueve**. Es lo que corresponde cuando el verificador no pudo
  ejecutar: sin alcance, conexión rechazada, timeout, el gate bloqueó, veredicto ilegible.

Un veredicto cuenta solo si el verificador dejó al menos una ejecución **firmada** de su propia sesión
y con **respuesta HTTP completa**. Por eso la tarea le pide usar `curl -i` o `-w '%{http_code}'`. Si el
instrumento falla, el resultado es "no pude comprobarlo", nunca "no existe".

## Configuración del reporte

En `.bounty/config.json`, solo lo edita el humano:

```json
{ "report_lang": "es", "report_redact": true }
```

- `report_lang`: `"en"` por defecto; `"es"` para el laboratorio. El modelo no ve estos valores como
  parámetros de herramienta, los aplica el código al escribir el reporte.
- `report_redact`: `true` por defecto. Enmascara `Cookie`, `Authorization`, tokens y datos personales
  de terceros (emails, tarjetas) **en el reporte escrito**. No cambia lo que ve el modelo, que sigue sin
  redacción para poder trabajar.

## Las tres pausas

Solo tres. Entre ellas, el agente trabaja solo.

El archivo de alcance tiene un campo obligatorio que no es decorativo:

```yaml
program: acme
lab: false        # false = programa real; true = laboratorio propio
```

Si te olvidás de `lab`, el alcance no carga. Si ponés `lab: true` en un programa real, estás
declarando que lo es, y las atafetas de test de la confirmación quedan habilitadas: no lo hagas.

**1. Primera vez que cargás un alcance.** Te muestra el resumen y espera tu OK una vez por programa:

```
Programa: acme
En alcance: 2 regla(s)
  - *.acme.com
  - api.acme.com:8443
Fuera de alcance: 1 regla(s)
  - admin.acme.com
Ritmo declarado: 5 req/s
A confirmar:
  - hay reglas con wildcard: cubren todos los puertos de los nombres que matchean

Esperando tu confirmación del alcance (decime "confirmo" y sigo).
```

**2. Cualquier cosa destructiva.** Siempre, aunque el modo sea automático:

```
Esto puede romper algo (binary "hydra" is a credential brute-force tool): hydra -L logins.txt
-P passwords.txt 127.0.0.1 ssh contra http://127.0.0.1:3000/login. ¿Lo autorizás?
```

Si decís que no, no se ejecuta nada y queda anotado.

**3. Antes de mandar un reporte.** Lo mandás vos, a mano.

## Leer `status.md`

Está en `work/<programa>/status.md` y se reescribe en cada cambio:

```markdown
# lab — estado

**Fase actual:** recon
**Qué está pasando:** Estoy viendo qué hay publicado en el alcance: hosts, endpoints, tecnologías.
**Alcance:** `work/lab/scope.yaml` (confirmado el 2026-11-12)

## Hallazgos (1)

- **F-0001** Clave de terceros en el bundle — sin confirmar
  - dónde: /static/app.js
  - hallazgo sensible — revisar antes de reportar

## Esperando tu confirmación

Nada pendiente: sigo solo.

## Qué sigue

anotada la inyección como observación; sigo con el inventario
```

Eso es todo lo que necesitás leer para saber en qué anda. Si querés lo mismo sin abrir el archivo,
pedile `bounty_status`.

Las siete fases son: `scope`, `recon`, `hypothesis`, `validate`, `triage`, `report`, `close`.

## Parar todo

```
bounty_stop { program: "acme", reason: "lo que sea" }
```

Mata los procesos que lanzó `bounty_run`, anota la parada en la cadena de evidencia y verifica que la
cadena siga consistente. Después de una parada no se ejecuta nada más hasta que lo pidas.

## Qué NO hacer

- **No convivas con otra sesión que tenga `bash` libre** en el mismo workspace. Si tenés un agente de
  coding abierto al lado, ese puede hacer `curl` y el gate no lo ve. Es una condición de uso, no un
  control técnico. Esta es la limitación más importante del proyecto.
- **No cargues un alcance real** sin leerlo y confirmarlo vos. El YAML es tu declaración de alcance,
  no la del agente.
- **No pongas credenciales en el repo.** Van en `.bounty/config.json`, que está gitignored.
- **No uses `scope/` ni `work/` en git.** También están gitignored.
- **No esperes que calcule CVSS solo.** El vector y el score se pasan ya validados; el calculador es
  una unidad pendiente.

## Límites y presupuesto

Cada corrida tiene techo: 45 minutos, 40 llamadas a herramientas y 2 millones de tokens (si el
runtime los reporta). Se configuran en `.bounty/config.json`:

```json
{ "budget": { "max_wall_ms": 1800000, "max_tool_calls": 40 } }
```

Al llegar al techo, el trabajo se detiene en orden y `status.md` lo dice. La evidencia ya escrita no
se pierde.

## Pizarra compartida: cómo se coordinan varios agentes

Cuando varios subagentes trabajan sobre el mismo programa, `bounty_board` es lo que evita que
trabajen a ciegas o repitan lo mismo.

- `bounty_board { program, action: "since", cursor: 0 }` — qué se descubrió hasta ahora.
- `publish` con `kind` (host, endpoint, param, hypothesis…), `target` y `data` chico. Es idempotente:
  el mismo descubrimiento dos veces es un solo ítem.
- `claim` antes de trabajar un ítem; el lease vence solo (10 min por defecto) y se puede renovar.
- `release` cuando terminás, para que otro lo tome.
- El autor es la sesión, no el texto: nadie puede publicar como otro.
- La pizarra guarda **forma**, no contenido: el payload crudo va a la cadena de evidencia.

La pizarra vive en `work/<programa>/board/` (`board.jsonl` + `claims.json`). Se lee bajo lock, igual
que la evidencia, así que varios procesos del mismo programa no se pisan.

## Enjambre: varios roles sobre el mismo programa

```
bounty_swarm { program: "acme", roles: ["authz-matrix", "js-analyst", "skeptic"],
               focus: "el endpoint de facturas", max_parallel: 3, budget_tool_calls: 1200 }
```

- Cada rol recibe solo su mandato y su allowlist; no ve el razonamiento del orquestador ni el de los
  otros roles.
- `max_parallel` por defecto 3. Subirlo no acelera nada: el ritmo lo impone el programa.
- `budget_tool_calls` es el techo **agregado**: cuando se agota, los roles restantes no se lanzan y el
  resultado dice cuáles.
- Al volver, el orquestador ve el resumen por rol y lo nuevo de la pizarra desde el cursor de arranque.
- Un hijo que falla no cancela a los demás.

Roles disponibles: `recon-surface`, `authz-matrix`, `js-analyst`, `schema-auditor`, `skeptic`.
Repetir un rol se rechaza: es redundancia, no cobertura.

## Varias cuentas: la matriz de autorización

Cuando el programa tiene cuentas de prueba (A, B, admin), cada una es **un archivo plano** que
escribís vos:

```bash
node --experimental-strip-types scripts/set-role.ts acme user-a ./user-a.headers
pbpaste | node --experimental-strip-types scripts/set-role.ts acme anonymous
```

El archivo queda en `work/acme/sessions/<rol>.headers` con permisos `0600`, dentro de `work/` (que ya
está gitignoted). Formato: `Name: value` por línea, `#` para comentarios. El script te muestra los
nombres de los headers y los avisos (por ejemplo, “no tiene Cookie ni Authorization”), nunca los
valores.

Dentro de la sesión:

- `bounty_session { program: "acme", action: "list" }` — qué roles hay, con qué headers y cuándo se
  actualizaron.
- `bounty_session { program: "acme", action: "check", role: "user-a" }` — un rol en particular.
- `bounty_run { ..., role: "user-a" }` — el mismo pedido con esa sesión. Si el archivo no existe se
  rechaza; no se cae a anónimo en silencio. Solo funciona con `curl`.

La credencial viaja en un config privado (`-K`), nunca en argv, así que la cadena de evidencia guarda
el nombre del rol y el nombre de los headers, no el valor. La comparación entre roles es un bucle que
hace el agente: mismo endpoint con `role: "anonymous"`, después con cada rol, y la diferencia va a la
pizarra.

> Decisión del operador (S106): archivo plano, host propio, cuentas de prueba descartables. Si algún
día eso deja de ser cierto, esta es la pieza que hay que cambiar, no el resto.

## Dónde vive todo

```
work/<programa>/
├── scope.yaml    ← lo escribís vos
├── status.md     ← leelo, es tu panel
├── state.json    ← fase y pendientes
├── board/        ← pizarra del enjambre (descubrimientos + leases)
├── findings/     ← un JSON por hallazgo
├── evidence/     ← log encadenado por hash + puntero de cabeza
└── reports/      ← reportes generados
```
## Cómo aportar una sesión humana al agente (S97)

Algunos programas (TheFork/DataDome) bloquean el login automatizado pero permiten operar si **vos** hacés
el login y le pasás la sesión a la herramienta.

1. Iniciá sesión en tu navegador, como siempre.
2. Copiá las cabeceras de tu sesión a `work/<programa>/session.headers`, una por línea:

```
Cookie: datadome=…; thefork-session=…
Authorization: Bearer eyJ…
```

3. Nada más. En cada llamada HTTP con `curl`, el arnés escribe un archivo privado (0600) en
   `work/<programa>/.session/curl.conf` y lo pasa con `-K`. **El valor de la cookie y el token nunca
   entran en argv ni en la cadena de evidencia**: se registran solo los nombres de las cabeceras inyectadas
   y la ruta del archivo.

Límites que no cambian:

- La sesión inyectada **no** satisface los `required_headers` del programa: el User-Agent sigue teniendo
  que ir por `-H` en argv, como exige el scope.
- Una sesión no autoriza a tocar nada fuera del alcance: el gate valida hosts igual que siempre.
- El archivo es del operador. El agente no lo crea, no lo edita y no debe imprimir su contenido.

Si el target devuelve un muro (403 con `x-datadome`, `cf-challenge`), la sesión se anota en `status.md`
como "Infraestructura protegida (WAF)" y el agente pivota a la superficie que acepta la sesión o a la API
que no dispara el reto. No se resuelven captchas ni se rota la identidad del cliente.

## Modo maratón: sesiones nocturnas y concurrentes (S90)

Presupuestos por volumen (`.bounty/config.json`): `max_tool_calls` 500, `max_duration_hours` 8,
`max_tokens` 25M. Tope por host en el scope: `limits.max_requests_per_host` (300 por defecto).

Para correr **varios programas en paralelo**:

```bash
bin/gentle-bounty atg &        # una terminal
bin/gentle-bounty thefork &    # otra
```

Lo que ya está probado con dos procesos: las cadenas de evidencia de programas distintos no se pisan, dos
sesiones del **mismo** programa serializan su escritura y **comparten el ritmo** (el limitador vive junto
al programa, no en el proceso). Si dos sesiones usan el mismo programa, el `rate_rps` se reparte, no se
duplica.

Ráfagas controladas (`bounty_run` con `burst: N`, máximo 12): N peticiones idénticas en paralelo, cada una
reservando su lugar en el ritmo, cada una en la cadena con su `burstIndex` y un `burstId` común. Sirve para
race conditions en cupones, stock o saldos. Si el gate clasifica la acción como destructiva, la pausa
humana sigue mandando.

Mass assignment (`mass_assignment: true`): el arnés mezcla en el cuerpo JSON un conjunto documentado de
claves de escalada (`isAdmin`, `role`, `verified`, `isStaff`, `permissions`, `emailVerified`) y registra
en la evidencia **qué claves agregó**.

Ramas y bucles: cinco firmas idénticas seguidas (403/429/404/5xx/timeout o marca de WAF) en la misma ruta
abandonan **esa rama** con `loop-detected` en `status.md`. La sesión sigue con otras rutas; no se queda
insistiendo.

## Reiniciar el reloj y los contadores: `--restart-limits` (S102)

Cuando la corrida se frena por presupuesto, hay un comando pensado para eso, en lugar de editar archivos a
mano:

```bash
bin/gentle-bounty --restart-limits underarmour     # un programa
bin/gentle-bounty --restart-limits --all           # todos
```

Qué hace: pone a cero **el uso** (`toolCalls`, `tokens`, `startedAt`, el sello de "presupuesto alcanzado")
en `state.json`, y anota un evento `budget-reset` en la cadena de evidencia con el uso anterior. No toca
los límites: esos siguen saliendo de `.bounty/config.json`.

Qué **no** hace: no cambia los límites. Si querés más horas o más llamadas, editá `.bounty/config.json`
(`max_duration_hours`, `max_tool_calls`) — es el otro paso, deliberadamente separado.

Para que una sesión **ya abierta** lo tome: recargá el alcance (`bounty_scope` sobre el mismo archivo,
que dice "ya lo confirmaste"). El reloj se reinicia en memoria y sigue. Si preferís, reiniciá la sesión.

## Ampliar presupuesto y seguir (S103)

```bash
bin/gentle-bounty --extend-budget underarmour --calls 800 --hours 12
```

Sube los límites en `.bounty/config.json` **y** reinicia los contadores con un evento `budget-reset` en la
cadena. Es una acción de la CLI: el agente no puede ampliarse el presupuesto a sí mismo.

Antes de lanzar una ráfaga, el arnés mira `work/<programa>/session.headers` y lee el `exp` del JWT: si al
token le quedan menos de 10 minutos avisa en `status.md`, y si ya expiró **cancela la ráfaga** y te pide un
storageState nuevo. Un 401/403 con sesión presente también queda anotado como posible caducidad.
