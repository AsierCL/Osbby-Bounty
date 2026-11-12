# Evidencia: tools del subagente real (S41)

Corrida real de un subagente con `pi` de verdad (no el stub de los tests), contra el lab local.

- Agente: `bounty-recon`
- Asset: `assets/agents/bounty-recon.md`
- Tarea: "Usá la herramienta bounty_status con program 'lab' y respondé únicamente la fase actual, en una palabra."
- Modelo: el configurado por defecto en el host
- Duración: 4943 ms · exit 0
- Tool calls que el hijo ejecutó: (ninguna)

## Allowlist declarada en el asset

```json
[
  "read",
  "grep",
  "find",
  "ls",
  "bounty_run",
  "bounty_scope",
  "bounty_evidence",
  "bounty_phase",
  "bounty_status"
]
```

## Tools que Pi reportó en `agent_end.toolsAdded`

```json
[
  "read",
  "grep",
  "find",
  "ls",
  "bounty_run",
  "bounty_scope",
  "bounty_evidence",
  "bounty_phase",
  "bounty_status"
]
```

## Comparación

- Tools de más (crítico): ninguna
- Tools declaradas y no habilitadas: ninguna
- Subconjunto de la allowlist global del runner: sí

## Veredicto

**OK: el hijo reporta exactamente su allowlist**

Salida del hijo (recortada):

```
(vacía)
```
