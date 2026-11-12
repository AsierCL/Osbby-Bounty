# Configuración

## Variables de entorno

| Variable | Default | Qué hace |
|---|---|---|
| `GENTLE_BOUNTY_ROOT` | `process.cwd()` | Raíz del workspace donde se crea `work/<programa>/` |
| `GENTLE_BOUNTY_REDACTION` | `off` | `on` activa la redacción de credenciales hacia el modelo (S26). El evidence store guarda el crudo igual |

## Archivo de configuración global

`.bounty/config.json` (gitignored). Claves admitidas; una clave desconocida invalida el archivo
entero, para que un typo no apague un límite en silencio.

```json
{
  "fetch_allow": ["github.com", "raw.githubusercontent.com"],
  "mcp": ["burp"],
  "redaction": "off",
  "budget": { "max_wall_ms": 1800000, "max_tool_calls": 40, "max_tokens": 2000000 },
  "accounts": { "userA": { "cookie": "<cookie>" } }
}
```

- **`fetch_allow`** — hosts desde los que el agente puede **descargar** (plantillas de nuclei, por
  ejemplo) aunque estén fuera del scope del programa. No agranda el scope: un host permitido para
  descargar no pasa a ser un target válido. Lo edita solo el operador; nunca va en el scope.
- **`mcp`** — servidores MCP aprobados para la sesión principal. Vacío ⇒ la sesión arranca con
  `--no-mcp`.
- **`redaction`** — `off` por defecto (S26).
- **`budget`** — techo por corrida (S37).

## Credenciales de cuentas de prueba

Van en `.bounty/config.json`, que está gitignored, y se pasan directo a los argumentos de
`bounty_run`. **No hay vault ni alias `${cred:...}`**: se decidió que el esquema agregaba fricción sin
agregar seguridad real, porque el agente podía leer el archivo igual.

```json
{
  "accounts": {
    "userA": { "cookie": "<pega acá la cookie de la cuenta A>" },
    "userB": { "cookie": "<pega acá la cookie de la cuenta B>" }
  }
}
```

Nunca commitees ese archivo. `.gitignore` ya lo excluye.

## Layout del workspace de un programa

```
work/<programa>/
├── scope.yaml        # entrada del humano
├── state.json        # fase, confirmaciones pendientes, notas
├── status.md         # resumen en lenguaje llano (se reescribe en cada transición)
├── findings/         # un JSON por hallazgo
├── evidence/         # log.jsonl + head.json (cadena de hashes)
└── reports/          # reportes generados
```
