# Consultas a la API de NVD (S52)

Consultas de **solo lectura** a la API oficial de NIST, autorizadas puntualmente por el humano como
extensión de S21a. Cada archivo es la respuesta cruda, sin editar.

| Archivo | URL | Fecha de consulta | Resultado |
|---|---|---|---|
| `CVE-2021-44228.json` | `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228` | 2026-11-12 | **sin `cvssMetricV40`** (solo v3.1 primary 10.0 y v2 9.3) |
| `CVE-2024-3400.json` | `…?cveId=CVE-2024-3400` | 2026-11-12 | sin `cvssMetricV40` |
| `CVE-2023-44487.json` | `…?cveId=CVE-2023-44487` | 2026-11-12 | sin `cvssMetricV40` |
| `CVE-2024-3094.json` | `…?cveId=CVE-2024-3094` | 2026-11-12 | sin `cvssMetricV40` |

## Hallazgo

Ninguno de los cuatro CVE conocidos probados tiene `metrics.cvssMetricV40` en la respuesta de la API,
ni primary ni secondary. Las claves presentes son `cvssMetricV31` y `ssvcV203`.

Consecuencia: **no hay segundo anclaje CVSS v4.0 obtenible por esta vía hoy**. Coincide con la
observación del humano de que las fuentes de terceros se contradicen sobre si NVD publicó v4.0 para
estos CVE. No se forzó ningún vector: se reporta el vacío en vez de inventar un número.

No se siguió consultando: S52 autorizó "un solo GET" con margen para "probar con otro", no un barrido.
