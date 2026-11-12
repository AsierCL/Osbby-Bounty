# Go / No-Go para apuntar a un programa real

Estado a la fecha del checkpoint 12. Se actualiza con evidencia, no con "los tests están verdes".

## Verificado con evidencia

| Qué | Cómo se verificó |
|---|---|
| Alcance: canonicalización, `out_of_scope` gana, escaneo genérico de argv, CNAME, `unknown` ⇒ rechazo | suite adversarial + property tests |
| Regla con puerto restringe el puerto; token sin puerto no matchea | tests + repro con el gate real |
| Confirmación del alcance atada al hash del archivo, por UI, sin autoconfirmación | tests + diálogo real (R1) |
| Clase prohibida por el programa ⇒ denegación dura, sin pausa | tests |
| Pausa destructiva: diálogo real, **ambas ramas**, tecla humana | corrida del operador (R6) |
| Desenlace de la confirmación informado al modelo; `status.md` sin pending obsoleto | tests (B2/B3) |
| Registros de sistema `gate` y `confirmation` en la cadena | tests (7a) |
| Cadena de evidencia: edición, truncado y reordenamiento detectados | tests |
| Presupuesto por corrida y parada de emergencia | tests |
| Sesión principal sin bash/fetch/write | `docs/evidence/main-session-tools.md` (Pi real) |
| Subagente de recon: tools = su allowlist | `docs/evidence/subagent-bounty-recon-tools.md` |
| Verificador: tools = su allowlist, sin `bounty_finding` | `docs/evidence/subagent-bounty-verify-tools.md` |
| `verified` solo por veredicto del verificador, con evidencia de su propia sesión | tests + flujo vivo |
| `bounty_report` calcula el score y escribe el reporte validado | tests + flujo vivo |
| Flujo completo en el lab: recon → finding → verificador real → verified → reporte | `docs/evidence/s43-live-run.md` |
| Kit de prueba con archivo previo y criterio de aceptación para (iii) | tests del kit |

## Pendiente

| Qué | Riesgo si se saltea |
|---|---|
| **Escenario (iii) en vivo** (salir de scope y ver el mensaje exacto en `status.md`) | El gate está probado, pero no lo viste bloquear en una sesión real. Es el último tramo de S43 |
| Escribir el scope de un programa real (humano, con `docs/COMO-ESCRIBIR-UN-SCOPE.md`) | Un scope mal escrito es el único error que puede cruzar la línea roja #1 |
| Métricas modificadas (`M*`) de CVSS | Se rechazan; si el programa exige vector ambiental, no hay reporte |
| Segundo anclaje real-world de CVSS | Deuda declarada; la validación descansa en la tabla oficial + invariantes |
| Skills de `gentle-pi` en el contexto de bounty | Ruido de prompt, no riesgo de alcance |
| Host en valor de wordlist (`-P/-L/-w`) sin validar | Hueco documentado en `docs/gate.md`, riesgo bajo |

## Recomendación

**GO condicionado** para un programa real de alcance chico, con `rate_rps` explícito, después de:

1. Correr el escenario (iii) en vivo una vez (2 minutos, el kit lo imprime).
2. Escribir el scope con `docs/COMO-ESCRIBIR-UN-SCOPE.md` y leer el resumen de `bounty_scope` antes de
   confirmar.
3. Primera sesión corta y con `status.md` a la vista.

**NO-GO** si el programa no declara alcance claro, si no se puede escribir un `out_of_scope`, o si se
va a usar sin `bin/gentle-bounty` (la restricción de la sesión principal es el control real).
