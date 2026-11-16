# Cómo escribir el scope de un programa

Una página. Si algo no se entiende, el problema es del documento.

## 1. De las reglas del programa al YAML

El programa dice cosas como *"*.acme.com está en alcance, salvo admin.acme.com; no escanees
status.acme.com; máximo 5 peticiones por segundo; identificáte con X-Bounty-Id"*. Eso se traduce
literal:

| El programa dice | Vos escribís |
|---|---|
| `*.acme.com` en alcance | `in_scope: ["*.acme.com"]` |
| el apex también | agregá `acme.com` aparte (el wildcard no lo cubre) |
| salvo `admin.acme.com` | `out_of_scope: ["admin.acme.com"]` |
| solo `api.acme.com:8443` | `api.acme.com:8443` (puerto incluido) |
| 5 req/s | `limits.rate_rps: 5` |
| "no DoS ni fuerza bruta" | `limits.forbidden: [dos, brute-force]` |
| header obligatorio (exacto) | `required_headers: { X-Bounty-Id: "...-..." }` |
| header obligatorio (contiene) | `required_headers: { User-Agent: { value: "bugcrowd", mode: "contains" } }` |
| "no a escaneo automatizado" | `automation.automated_scanning: forbidden` |

**No agregues nada que el programa no diga.** Ni un dominio "por si acaso", ni un puerto extra.

## 2. Ambigüedades: la regla es siempre la misma

**Ante la duda, afuera.** Dos formas, según el caso:

- Un host que *creés* que es del programa pero no está listado → **no lo pongas** en `in_scope`.
- Un host que el programa menciona y no sabés si está permitido → ponelo en `out_of_scope` y anotá la
  duda en `notes`. Excluir de más cuesta una oportunidad; incluir de más cruza la línea roja #1.

El gate trata "no cubierto" como **denegado**, así que no incluirlo es seguro: el agente no va a
tocarlo y te va a decir por qué.

## 3. Si el programa no declara `rate_rps`

El gate **niega todo** cuando el scope no declara rate. No es un bug: un presupuesto que no existe no
se puede respetar. Entonces hay que elegir un número, y el número es **2 req/s**.

Por qué 2:

- Está por debajo de lo que tolera casi cualquier programa (los que publican límites suelen decir 5).
- A 2 req/s hacés 1.000 requests en ~8 minutos: suficiente para un recon serio de un alcance chico.
- Si el programa **sí** declara un límite, ese manda. Nunca pongas uno más alto que el declarado.

Y dejalo escrito en `notes`: *"el programa no declara rate; usé 2 req/s por prudencia"*. Si el
programa después se queja, la nota es tu defensa.

## 4. Cómo leer el resumen de `bounty_scope` antes de confirmar

Al cargar, la tool te muestra el resumen y espera **una** confirmación tuya. Mirá tres cosas:

1. **Reglas interpretadas**: que cada línea de `in_scope` sea lo que el programa dice, no lo que
   vos recordás.
2. **Avisos**: si aparecen, es que algo falta. Los típicos: falta `authorized_on`, `in_scope` vacío,
   falta `rate_rps`.
3. **Ambigüedades**: si hay wildcards, te avisa que cubren todos los puertos; si no hay
   `out_of_scope`, te avisa que el programa no excluye nada explícitamente.

Si algo no coincide, **no confirmes**: corregí el YAML, recargá, y mirá de nuevo.

## 5. Tres errores típicos

**1. Confiar en que `*.acme.com` incluye `acme.com`.** No lo incluye. Si el apex está en alcance,
agregalo como regla aparte. Si no lo agregás, el agente no va a tocar el apex y te va a decir
"no in_scope rule matched acme.com".

**2. Poner un host en `in_scope` porque "seguro es del programa".** Un `dev.acme.com` que no figura
en el programa es un host fuera de alcance. Va afuera, o no va. El resumen de `bounty_scope` no te va
a salvar de eso: te va a mostrar la regla que vos escribiste.

**3. Dejar `rate_rps` sin declarar "porque el programa no dice nada".** El gate entonces niega todo y
vas a pensar que está roto. Poné 2 y anotá el motivo (punto 3).

## 6. Errores que el parser te va a marcar

- Campo desconocido (`limit:` en vez de `limits:`): el archivo **entero** no carga. Es a propósito:
  un typo no puede apagar un límite en silencio.
- `lab` ausente o con valor distinto de `true`/`false`.
- Wildcard suelto (`*`, `*.*.com`).
- Tabs para indentar: solo espacios.
- Un `in_scope` que no es lista.

Cada uno devuelve un mensaje con la línea. Si el mensaje no alcanza, `bin/gentle-bounty --preflight
<programa>` te dice qué chequeo falla antes de arrancar.

## Límites de volumen (S89)

En `limits`, junto a `rate_rps`:

| Campo | Por defecto | Qué significa |
|---|---|---|
| `rate_rps` | sin declarar (y sin declarar no corre nada) | ritmo, compartido por todas las sesiones del programa |
| `max_requests_per_host` | **300** | ejecuciones reales contra un host dentro de una corrida; al llegar, deniega ese host y la sesión puede seguir con otros |

## Presupuesto en `.bounty/config.json` (S89)

| Clave | Por defecto | Por qué |
|---|---|---|
| `max_tool_calls` | **500** | una noche de trabajo metódico, no una corrida corta |
| `max_duration_hours` | **8** | red de seguridad, no el límite principal: generoso a propósito |
| `max_tokens` | **25 000 000** | ~50k tokens por llamada × 500, con margen |

El presupuesto por volumen manda; el reloj solo evita una sesión desbocada.
