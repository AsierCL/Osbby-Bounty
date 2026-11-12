# Evidencia: tools de la sesión principal (S34)

Corrida real de `bin/gentle-bounty smoke --probe scripts/tools-probe.ts -- --mode json "Responde solamente: ok"`,
workspace vacío, prompt mínimo, autorizada por S38 bajo S1b. Modelo: deepseek-v4.1-flash vía opencode-go
(3.603 tokens, USD 0.00054).

Pi reporta en su propio evento `agent_end` la lista de tools que efectivamente habilitó:

```json
[
  "read",
  "grep",
  "find",
  "ls",
  "bounty_scope",
  "bounty_run",
  "bounty_evidence",
  "bounty_finding",
  "bounty_phase",
  "bounty_status",
  "bounty_stop"
]
```

- `bash`: ausente.
- `write` / `edit`: ausentes.
- `fetch` / `web_search`: ausentes.
- Las siete tools de bounty están registradas: la extensión carga en Pi real.
- cwd de la sesión: `<cwd>
/home/opencode-agent/GentleBounty/gentle-bounty/work/smoke
</cwd>`

Verificado leyendo el evento, no preguntándole al modelo qué tools tiene.
