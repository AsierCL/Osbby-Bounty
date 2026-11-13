# Go / No-Go para apuntar a un programa real

Estado a la fecha del checkpoint 14 (S75). Se actualiza con evidencia, no con "los tests están verdes".

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
| Cadena que no se pierde: el cleanup archiva con timestamp en vez de borrar | tests (`cleanup-archives`) |
| Kit idempotente: `authorized_on` constante, sin archivo ni reescritura si el scope es idéntico | test con reloj falso a ambos lados de medianoche |
| Presupuesto por corrida y parada de emergencia | tests |
| Sesión principal sin bash/fetch/write | `docs/evidence/main-session-tools.md` (Pi real) |
| Subagente de recon: tools = su allowlist | `docs/evidence/subagent-bounty-recon-tools.md` |
| Verificador: tools = su allowlist, sin `bounty_finding` | `docs/evidence/subagent-bounty-verify-tools.md` |
| `verified` solo por veredicto del verificador, con evidencia de su propia sesión | tests + flujo vivo |
| Verificador firmado por invocación (HMAC), veredicto sin token rechazado | tests (`verifier-signature`) |
| Semántica de veredictos: REPRODUCIDO y NO_REPRODUCIDO exigen una ejecución firmada con respuesta HTTP completa; sin eso el veredicto efectivo es INCONCLUSO y el hallazgo no se mueve | tests (`verdict-semantics`, `verify-inconclusive`) |
| NO_REPRODUCIDO válido sobre `candidate` ⇒ `rejected`; sobre `verified` ⇒ `disputed`, que resuelve el operador | tests (`verdict-semantics`) |
| El hijo del verificador conoce su programa (tarea + `GENTLE_BOUNTY_PROGRAM`) y no puede tocar otro: las tools rechazan otro nombre | tests (`program-lock`) |
| `report_redact` cubre toda la prosa del reporte, no solo los extractos | tests (`report-quality`) |
| `bounty_report` calcula el score y escribe el reporte validado | tests + flujo vivo |
| Flujo completo en el lab: recon → finding → verificador real → verified → reporte | `docs/evidence/s43-live-run.md` |
| Escenario (iii) en vivo: bloqueo, registro `gate`, sin `execution` — **S43 completo** | corrida del operador (R11) |
| Calidad del reporte: resumen ≠ título (dos frases), condiciones derivadas del vector, evidencia extraída de la cadena con firma, redacción por defecto, esperado vs observado, `report_lang` | tests (`report-quality`) |
| Preflight de scope sin sesión: mismo resumen que `bounty_scope` + avisos legibles | tests (`preflight-scope`, `preflight`) |
| Sesión de bounty sin el catálogo de skills de Pi (`-ns`) | test del launcher + argv del hijo |

## Pendiente (bloqueante para el primer tráfico real)

| Qué | Riesgo si se saltea |
|---|---|
| ~~Corrida viva completa de punta a punta~~ | **Verificada en R14 (S76)**: recon → finding → verificador real (47s, REPRODUCIDO con seq 5 y 7 firmadas) → verified → reportero real (15s) → reporte escrito. Ver `docs/evidence/s76-live-run.md` |
| **Revisión humana del reporte generado** (lo revisa el operador, no el agente) | Un reporte que contradice su propio vector, o que filtra un secreto, lo rechaza la plataforma |

**El primer tráfico real sigue bloqueado** hasta que el operador revise el reporte generado
(`work/lab-flow/reports/F-0001.md`, copiado a `docs/evidence/s76-live-run.md`). El flujo ya pasó de punta
a punta con modelo real.

## Pendiente (no bloqueante, deuda declarada)

| Qué | Riesgo si se saltea |
|---|---|
| Métricas modificadas (`M*`) de CVSS | Se rechazan; si el programa exige vector ambiental, no hay reporte |
| Segundo anclaje real-world de CVSS | Deuda declarada; la validación descansa en la tabla oficial + invariantes |
| Host en valor de wordlist (`-P/-L/-w`) sin validar | Hueco documentado en `docs/gate.md`, riesgo bajo |
| El `cp -r` manual + cleanup viejo que borró `work/lab-s43` | Ya arreglado: el cleanup archiva; queda como anécdota de R12 |

## Recomendación

**GO condicionado** para un programa real de alcance chico, después de la corrida viva pendiente.

**Criterio de primer programa** (las tres condiciones juntas):

1. **Hosts explícitos** en `in_scope`: uno por línea, con puerto cuando el programa lo declara. Nada de
   wildcards el primer día: un wildcard sin puerto cubre todos los puertos.
2. **`rate_rps: 2`** si el programa no declara otro ritmo. Por encima de 10 req/s el preflight avisa.
3. **Primera sesión supervisada**: alguien mira `status.md` y la cadena mientras corre; sesión corta,
   un solo hallazgo como objetivo.

Además: escribir el scope con `docs/COMO-ESCRIBIR-UN-SCOPE.md`, leer el resumen interpretado
(`./bin/gentle-bounty --preflight <programa>` sirve sin abrir sesión) y confirmarlo una sola vez.

**NO-GO** si el programa no declara alcance claro, si no se puede escribir un `out_of_scope`, o si se
va a usar sin `bin/gentle-bounty` (la restricción de la sesión principal es el control real).
