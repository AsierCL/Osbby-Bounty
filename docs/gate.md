# El gate: orden de decisión y consecuencias documentadas

`src/core/gate.ts` es el único punto donde se decide si una acción toca la red. Este documento fija
el orden de las decisiones y las dos consecuencias incómodas que se aceptan a propósito.

## Orden de decisión

Una acción se deniega en el primer chequeo que falla. No hay "warn and continue".

1. **Método** en la allowlist del programa (`limits.allowed_methods`). Lista vacía = sin restricción.
2. **Técnica** prohibida (`limits.forbidden`), por ejemplo `dos` o `brute-force`.
3. **Redirects**: si se piden y la política es `reject`, se deniega. Con `revalidate`, se permite y
   se emite la nota de que **cada salto debe re-validarse**.
4. **Headers obligatorios** del programa (`required_headers`): si falta uno, se deniega.
5. **Rate declarado**: si el scope no declara `rate_rps`, se deniega todo. Un presupuesto que no
   existe no se puede respetar.
6. **Alcance de cada host contactado**: target, URLs del argv, hosts sueltos del argv, archivos de
   `-l`, cabeceras `Host`/`X-Forwarded-Host`, y la cadena CNAME de DNS. `unknown` deniega.
7. **DNS**: si resolver falla, se deniega. Si un CNAME apunta fuera de alcance, se deniega nombrando
   el destino.

## Consecuencia 1: un token con forma de host bajo un flag desconocido se deniega

`nuclei --whatever ambiguous.json` se deniega: `ambiguous.json` podría ser un nombre de host. El gate
no adivina. Para que no moleste, hay una lista explícita de flags cuyo valor es una ruta local
(`-o`, `-t`, `-w`, `--config`, `--output-dir`, …). Si aparece una tool nueva con un flag de archivo
nuevo, se agrega a esa lista — es una decisión de código, revisable, no un umbral difuso.

## Consecuencia 2: un wildcard no está calificado por puerto

`*.acme.com` cubre **todos** los puertos de todos los nombres que matchea. Si el programa dice
`*.acme.com`, entonces `api.acme.com:9999` está en alcance por esa regla, y una regla
`api.acme.com:8443` no lo restringe (agregar permisos no quita permisos). Para restringir un puerto
hay que no otorgar el host por wildcard.

Se eligió así porque refleja cómo las plataformas describen el alcance y porque el matcher
alternativo ("la regla más específica gana") vuelve imposible razonar sobre el scope con la lectura
lineal del programa.

## Semántica de las reglas

| Regla | Matchea | No matchea |
|---|---|---|
| `acme.com` | `acme.com` | `a.acme.com` |
| `*.acme.com` | `a.acme.com`, `a.b.acme.com` | `acme.com` (apex), `notacme.com` |
| `host:8443` | `host` en 8443 | `host` en 443 |
| `host/static/*` | path que empieza con `/static/` | `/app/x` |
| `10.0.0.5` | esa IP | cualquier nombre |
| `*.acme.com` | — | cualquier IP |

`out_of_scope` siempre gana sobre `in_scope`. Sin match: `unknown`, que el gate trata como denegado.

## Lo que la suite adversarial cubre

Confusión de userinfo (`acme.com@otro.com`), homóglifos IDN y su forma punycode, punto final,
mayúsculas, IPv6, IPv4 en decimal/octal/hex/abreviado, puertos, `*.dominio` vs apex,
`dominio.com.otro.com`, lookalikes de sufijo, callbacks OOB en argv, `Host`/`X-Forwarded-Host`
ajenos, CNAME a terceros, y `unknown ⇒ rechazo`. Más seis invariantes de propiedad sobre PRNG
sembrado, incluida "el gate nunca permite lo que el matcher llama unknown u out".
