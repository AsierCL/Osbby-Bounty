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

## Dónde vive todo

```
work/<programa>/
├── scope.yaml    ← lo escribís vos
├── status.md     ← leelo, es tu panel
├── state.json    ← fase y pendientes
├── findings/     ← un JSON por hallazgo
├── evidence/     ← log encadenado por hash + puntero de cabeza
└── reports/      ← reportes generados
```
