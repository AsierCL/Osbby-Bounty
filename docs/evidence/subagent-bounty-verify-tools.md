# Evidencia: verificador real contra el lab (S66 en vivo, A3)

Corrida real de `bounty-verify` con `pi` de verdad y modelo real, contra el **lab local propio**
(127.0.0.1:8793, levantado en el worktree `wip-verifier`, no en el puerto del operador). Solo datos
del lab (S1b).

- Comando: `node --experimental-strip-types scripts/verify-finding.ts lab F-0001`
- Fecha: 2026-11-12
- Duración: **109.428 ms** · exit **0** · `ok=true`
- Hallazgo: `F-0001` (IDOR en facturas del lab), creado como `candidate` con evidencia real de dos
  `curl` a `/api/invoices/1` y `/api/invoices/2`.

## Allowlist del asset vs tools reportadas por Pi

```json
// assets/agents/bounty-verify.md:4
["read","grep","find","bounty_run","bounty_scope","bounty_evidence","bounty_finding","bounty_status"]

// agent_end.toolsAdded del hijo real
["read","grep","find","bounty_run","bounty_scope","bounty_evidence","bounty_finding","bounty_status"]
```

**Coinciden exactamente. Cero tools de más. Sin `bash`, sin `write`, sin `fetch`.** Igual que la
verificación de `bounty-recon` (S41), ahora para el verificador.

## Lo que NO funcionó (dos defectos, sin parchear)

**D1 — `verified` es inalcanzable hoy.** El hijo terminó `ok=true` y el hallazgo siguió en
`candidate`:

```
state: candidate | transitions: [(None, 'candidate', 'created')]
```

Causa: la tarea del verificador (`src/pi/verifier.ts:71-73`) le pide **responder** `REPRODUCIDO` o
`NO REPRODUCIDO` con las salidas, pero **nunca** le pide marcar el hallazgo; y la sesión principal
tiene prohibido hacerlo (guard de S66 en `src/pi/session.ts`). El verificador tiene `bounty_finding`
en su allowlist y no lo usa, y el padre no puede: `verified` queda sin nadie que lo escriba, y
`bounty_report` (que exige `verified`) queda inalcanzable. Observable: no se escribió nada en
`work/lab/reports/`.

**D2 — el veredicto del hijo no llega al padre.** `result.output` volvió **vacío**. Causa:
`parseEvents` solo lee `text`, `content` y `delta` de primer nivel (`src/pi/runner.ts:176-179`),
mientras que Pi real emite el texto dentro de
`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"…"}]}}`. El
parser no mira ahí, así que cualquier respuesta del hijo se pierde aunque conteste bien.

## Hallazgo colateral (corregido en esta rama): la evidencia estaba gitignorada

`.gitignore` tenía una línea `evidence/` pensada para el evidence store de los programas. Ese patrón
también matcheaba **`docs/evidence/`**, así que todos los artefactos que el humano pidió guardar
(`main-session-tools.md`, `subagent-bounty-recon-tools.md`, `confirm-live.md`, los JSON de NVD)
estaban **sin trackear**: existían en el disco y se perdían con cualquier clon. Corregido: el store
vive bajo `work/` (ya ignorado) y `docs/evidence/` se trackea.

## Qué NO se pudo correr

El tramo `verified → bounty_report → reports/<id>.md` **no se ejecutó**: depende de D1. No lo simulé
marcando el hallazgo a mano porque eso sería el atajo que S66 prohíbe.
