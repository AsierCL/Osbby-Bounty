# Validación S104 (2026-11-17): fase 0, sesión obligatoria y presupuesto por valor

**Ningún host real recibió tráfico.** Esta sesión es la de herramientas: no tiene el gate cargado, así que
un `curl` desde acá sería exactamente el bypass que el arnés existe para impedir. Los tres escenarios se
validaron con el código real y datos locales/simulados.

## Escenario 1 — Fase 0 (`bounty_recon`)

**Bloqueante real**: `subfinder` y `katana` no están instalados, y el `httpx` del PATH es el cliente de
Python, no el de Project Discovery (el preflight lo avisa). No se instala nada sin decisión del operador.

Prueba del pipeline con las dos herramientas simuladas (mismo código, mismas funciones de parseo y filtro):

```
Fase 0: 3 subdominio(s) → 2 vivo(s) (2xx/3xx/401/403).
- 200 https://a.acme.com — A
- 403 https://b.acme.com
```

`alive-hosts.json`:

```json
[ { "url": "https://a.acme.com", "status": 200, "title": "A" },
  { "url": "https://b.acme.com", "status": 403 } ]
```

El `503` de `c.acme.com` se descartó. Lo que falta para una corrida real: instalar `subfinder` y el
`httpx` de Project Discovery en un directorio de `tool_path`.

## Escenario 2 — `requires_session` (onetrust)

Añadido `requires_session: true` a `work/onetrust/scope.yaml` (el programa es un WAF duro). Preflight:

```
OK    el scope parsea y declara lab: false
Sesión obligatoria: inyectá work/<programa>/session.headers antes de correr nada
```

Intento de ejecución sin sesión:

```
resultado: BLOQUEADO
mensaje: El programa exige sesión inyectada (requires_session) y no hay
         work/onetrust/session.headers. El operador inicia sesión en su navegador y deja ahí las
         cookies/storageState; no se intenta login automatizado.
procesos lanzados: 0
```

Cero procesos: no hay POST a /login, no hay intento que pueda disparar DataDome.

## Escenario 3 — Presupuesto por valor (cap 10, reserva 20% = 2)

| Momento | Objetivo | Resultado |
|---|---|---|
| 8/10 usadas | `/about-9` (página) | **RECHAZADA**: "quedan 2 de 10 y el objetivo es una page (prioridad 10)" |
| 8/10 | `/api/v2/users/1` | **PERMITIDA** |
| 9/10 | `/graphql` | **PERMITIDA** |
| 10/10 | `/about-10` | **RECHAZADA** |

Las 8 páginas iniciales consumieron el tramo no reservado; el último 20% quedó intacto hasta que llegaron
los objetivos de alto valor.

## Pendiente para correr sobre los programas reales

1. Instalar `subfinder` y `httpx` (Project Discovery) — decisión del operador.
2. Abrir cada programa en una sesión de bounty, confirmar el alcance (la tecla humana) y correr
   `bounty_recon` desde ahí, no desde esta sesión.
3. Para onetrust: iniciar sesión en el navegador y dejar `work/onetrust/session.headers` antes de
   cualquier `bounty_run`.
