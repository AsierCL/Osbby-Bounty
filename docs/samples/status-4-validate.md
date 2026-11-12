# lab — estado

**Fase actual:** validate
**Qué está pasando:** Estoy comprobando si una debilidad concreta es real, con la prueba más chica posible.
**Alcance:** `/home/opencode-agent/GentleBounty/gentle-bounty/work/lab/scope.yaml` (confirmado el 2026-11-12)

## Hallazgos (2)

- **F-0001** Clave de terceros en el bundle — sin confirmar
  - dónde: /static/app.js
  - hallazgo sensible — revisar antes de reportar
- **F-0002** IDOR en facturas — confirmado
  - dónde: /api/invoices/2 (parámetro id)

## Esperando tu confirmación

Nada pendiente: sigo solo.

## Qué sigue

Si se confirma, lo paso a triage y escribo el reporte.
