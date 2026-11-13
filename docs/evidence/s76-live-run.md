# Evidencia: corrida viva de S76 (R14)

Fecha: 2026-11-13 · lab local en `127.0.0.1:8787` · `pi` real, modelo real, solo datos del lab.

`work/lab-flow` se archivó antes de empezar con el cleanup nuevo:
`work/lab-flow-archivo-20261113-222519` (el `F-0001` rechazado de R13 queda ahí como evidencia del fallo).

## Qué corrió, con qué tools y cuánto tardó

| Paso | Resultado |
|---|---|
| 1. scope | cargado y confirmado (stub humano, headless) |
| 2. recon principal | portada 200 · factura ajena de bob 200, dos `curl` reales |
| 3. finding | `F-0001` candidato, `/api/invoices/2` |
| 4. verificador | 47 s · tools `read, grep, find, bounty_run, bounty_scope, bounty_evidence, bounty_status` (exactamente su allowlist) |
| 5. veredicto | `REPRODUCIDO` seqs 5 y 7 · efectivo `REPRODUCIDO`, sin conversión · `F-0001` pasó a `verified` |
| 6. reportero | 15 s · tools `read, grep, find, ls` · prosa del modelo, guardada en `reports/F-0001.prose.json` |
| 7. reporte | escrito en `work/lab-flow/reports/F-0001.md` |

## Cadena (9 registros, `verify()` ok)

```
1  execution          sesión principal (sin firma, por diseño)
2  execution-result
3  execution          sesión principal (hallazgo inicial)
4  execution-result
5  execution  child    firma 25048b747d… · curl -sS -i /api/invoices/2
6  execution-result   200 OK + cuerpo de bob
7  execution  child    firma 0298342f78… · curl -sS -i /api/invoices/2
8  execution-result   200 OK + cuerpo de bob
9  verification       efectivo=REPRODUCIDO convertido=false seqs=[5,7]
```

`status.md` muestra el evento: `F-0001: verified — REPRODUCIDO … seq 5, 7 firmada por la sesión del
verificador` con fecha 2026-11-13 21:26:22 UTC.

## Dos cosas que salieron mal y cómo quedaron

1. **El primer intento no escribió reporte**: el extractor de JSON del script tomaba el primer `{` y el
   último `}` del volcado del hijo, y el volcado puede traer varios bloques. El modelo había devuelto
   JSON válido (`last-of-3`). Se arregló con `scripts/lib/prose.ts` (objetos balanceados, último
   primero) y el script ahora imprime el diagnóstico en vez de un `null` mudo.
2. **El hijo del verificador pasó `curl` dentro de `args`**: el argv registrado quedó
   `["curl","curl","-sS","-i",url]` y curl intentó resolver el host `curl` (`stderr: Could not resolve
   host: curl`) aunque la petición real respondió 200 y el proceso salió 0. La evidencia es real, pero
   el argv tiene el nombre duplicado: queda como observación para decidir si se normaliza.

## Reporte generado (texto íntegro)

Ver `work/lab-flow/reports/F-0001.md`. Copia literal en la respuesta del checkpoint.
