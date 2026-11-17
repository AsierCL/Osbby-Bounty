# gentle-bounty

Infraestructura de control para bug bounty sobre Pi. No es un escáner: es la capa que decide qué se
puede tocar, a qué ritmo, con qué registro y con qué evidencia.

**Estado: Fase D (adaptador Pi).** El núcleo está testeado; la extensión todavía no corrió dentro de
una sesión de Pi real.

## Dos líneas rojas

1. **Nunca tocar nada fuera de scope.**
2. **Nunca fuerza bruta, DoS/DDoS ni ninguna clase destructiva sin confirmación explícita.**

Todo lo demás prioriza autonomía y fricción mínima.

## Cómo se usa

Arrancá la sesión con el lanzador, no con `pi` a mano: es el que aplica la allowlist de la sesión
principal (`--no-mcp`, `-ne`, `--tools` sin bash/fetch/write).

```bash
bin/gentle-bounty acme            # sesión restringida, cwd en work/acme/
bin/gentle-bounty acme --check    # muestra el argv exacto y no lanza nada
```

Para parar todo: `bounty_stop { program: "acme" }`. Mata los procesos de `bounty_run`, anota la
parada en la cadena de evidencia y verifica que siga consistente.

Guía de uso en castellano llano: `docs/USO.md`. Ejemplos reales de `status.md` por fase (generados
por `scripts/vertical-slice.ts` contra el lab local): `docs/samples/`.

```bash
# 1. Scope del programa (lo escribe el humano, no el agente)
work/acme/scope.yaml

# 2. Dentro de Pi, con la extensión cargada
bounty_scope { program: "acme", file: "work/acme/scope.yaml" }
#   → resumen en lenguaje llano + una única confirmación
bounty_run   { program: "acme", tool: "httpx", args: ["-u","https://a.acme.com"], target: "https://a.acme.com" }
bounty_phase { program: "acme", phase: "recon" }
bounty_status{ program: "acme" }
bounty_blackboard { program: "acme", action: "publish", category: "endpoint", target: "https://a.acme.com/api" }
bounty_swarm  { program: "acme", target: "https://a.acme.com" }
```

Cada transición reescribe `work/<program>/status.md`: qué fase corre, qué se encontró, qué espera
confirmación y qué sigue. `bounty_status` devuelve ese mismo texto, así que el humano y el modelo
leen lo mismo.

## Estructura

| Ruta | Qué es |
|---|---|
| `src/core/` | `bounty-core`: scope, gate, limiter, evidencia encadenada, redactor, proxy. Sin dependencias, sin Pi |
| `src/pi/` | Runner de subagentes y sesión del programa |
| `extensions/` | Shim delgado que registra las seis tools en Pi |
| `assets/` | Identidad, protocolo de siete fases, agentes con allowlist |
| `work/<programa>/` | Estado, hallazgos, evidencia y reportes (**gitignored**) |

## Condiciones de uso

- **Este diseño depende de que la sesión de bounty no comparta contexto con otra sesión que tenga
  `bash` libre** (por ejemplo un agente de coding en el mismo workspace). Si conviven, la otra sesión
  puede `curl` y el gate no la ve. Es una condición de uso, no un control técnico.
- `scope/` y `work/` nunca se commitean.
- El scope declara `lab: true` (laboratorio propio) o `lab: false` (programa real). Es obligatorio: sin
  ese campo el alcance no carga. Las atafetas de test de la confirmación solo funcionan con
  `lab: true`; si están activas y el scope es real, la sesión se niega a cargar el alcance.
- Las credenciales de cuentas de prueba viven en `.bounty/config.json` (gitignored) y se pasan
  directo a los argumentos. No hay vault ni alias.
- **La redacción de credenciales está apagada por defecto** (`GENTLE_BOUNTY_REDACTION=on` para
  prenderla). El evidence store guarda el crudo igual.

## Tests

```bash
npm test           # 150+ tests, sin red, sin modelo, sin Pi
npm run test:live  # smoke real: un `pi` hijo con prompt mínimo y workspace vacío (opt-in)
```

Los tests no hacen DNS real, no abren sockets fuera de localhost y no ejecutan código de terceros.

## Documentación

- `docs/adr/0001` — empaquetado (paquete aparte, runner propio)
- `docs/adr/0002` — toolchain (`node --experimental-strip-types`, sin build)
- `docs/adr/0003` — cierre de la vía `bash` (histórico; su firewall ya no es requisito)
- `docs/adr/0004` — el control es de configuración, no de red
- `docs/gate.md` — orden de decisión del gate y limitaciones conocidas
- `docs/config.md` — variables de entorno y archivo de credenciales
