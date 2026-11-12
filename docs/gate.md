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

## Escaneo genérico de argv (S24)

No hay perfiles por herramienta. Cada token que **parsea como host, URL o IP** se valida contra el
alcance, sin importar qué flag lo acompañe. Una tool nueva funciona sin configuración previa.

Un token que **no parsea como host** no bloquea: se anota en las notas del gate y el run sigue. Por
eso `-rl 150`, `-severity critical,high` o `frobnicate` no molestan.

Queda una lista global y corta de flags cuyo valor es una **ruta local** (`-o`, `-t`, `-w`,
`--config`, `--output-dir`, …), para que `-o out.json` no se confunda con un host. Es una lista
global, no un perfil por herramienta: si aparece una tool nueva con un flag de archivo nuevo, se
agrega ahí.

Host-shaped token que sí parsea y está fuera de alcance ⇒ **se deniega**. Es la línea roja #1.

## Limitación conocida: un wildcard no está calificado por puerto (S25, aplazada)

`*.acme.com` cubre **todos** los puertos de todos los nombres que matchea. Si el programa dice
`*.acme.com`, entonces `api.acme.com:9999` está en alcance por esa regla, y una regla
`api.acme.com:8443` no lo restringe (agregar permisos no quita permisos). Para restringir un puerto
hay que no otorgar el host por wildcard.

Se eligió así porque refleja cómo las plataformas describen el alcance y porque el matcher
alternativo ("la regla más específica gana") vuelve imposible razonar sobre el scope con la lectura
lineal del programa.

**Estado: aplazada.** No bloquea fases D ni E. Se corrige cuando convenga.

## Clasificación destructiva: inferida, no declarada (S35)

La clase que declara el modelo **solo suma**. El gate la infiere del binario y del argv:

| Señal | Fuerza | Ejemplo |
|---|---|---|
| Binario de fuerza bruta | fuerte | `hydra`, `medusa`, `ncrack`, `patator`, `crowbar`, `legba`, `john`, `hashcat` |
| Flag de flooding | fuerte | `--flood`, `-dos`, `--rate-limit 0` |
| Rate explícito por encima del `rate_rps` del programa | fuerte | `ffuf -rate 200` con `rate_rps: 5` |
| Rate explícito sin rate declarado en el programa | fuerte | `-rate 20` con scope sin `rate_rps` |
| Tags intrusivos de nuclei | fuerte | `-tags cve,dos` |
| Wordlist de contraseñas contra login/sesión | fuerte | `rockyou.txt` contra `/login` |
| Clase destructiva declarada o en `forbidden` | fuerte | `technique: "dos"` |
| Wordlist con pinta de contraseñas en otro lado | débil | `-w pw-list.txt` contra `/static` |
| Concurrencia alta | débil | `-c 50` |
| Target es login/sesión | débil | `/api/login` |

Fuerte ⇒ pausa y pide confirmación. Dos débiles juntas ⇒ también. Ante la duda, pausa: un falso
positivo cuesta una confirmación, un falso negativo cruza la línea roja #2.

## Flags de archivo: rutas locales vs descargas (S33)

El valor de un flag de archivo (`-o`, `-t`, `-w`, `--config`, `-P`, `-L`, …) es una **ruta local** y
no se valida, salvo que tenga esquema (`https://…`): en ese caso la tool lo va a **descargar**, o sea
es tráfico de red, y se valida contra el scope. Si no está en el scope pero sí en `fetch_allow`
(config global del operador, no del programa), pasa; si no, se deniega con motivo.

`-l` es siempre lista de hosts. Una tool que use `-l` para otra cosa se va a negar (falla cerrado),
no se va a ejecutar sin validar.

## Hueco conocido: valores de wordlist (S44, documentado, no arreglado)

Los flags de wordlist (`-P`, `-L`, `-w`, `--passwords`, `--login-list`, `--wordlist`) están en la
lista de **valor = ruta local**, así que su valor **no se valida**. Es necesario para que
`-P passwords.txt` no se confunda con un host (`passwords.txt` parsea como hostname).

Consecuencia, con el mismo nivel de detalle que el hueco de `-o`/`-t` ya cerrado:

| Caso | Qué pasa hoy | Qué debería pasar |
|---|---|---|
| `-P /tmp/words.txt` | pasa, es ruta local | igual: no es un host |
| `-P https://otro.com/words.txt` | **pasa sin validar** | debería validarse como descarga, igual que `-t https://otro.com/x.yaml` (S33) |
| `-w http://192.0.2.1/list.txt` | **pasa sin validar** | idem: es tráfico de red con esquema |
| `-L otro.com` (sin esquema) | pasa como ruta local | discutible: un host sin esquema en un flag de archivo |

El arreglo natural es extender a los flags de wordlist la misma regla de S33: si el valor tiene
esquema, es descarga y se valida (scope primero, después `fetch_allow`). No está implementado.

Riesgo real: **bajo pero no nulo**. Requiere que una tool descargue una wordlist desde una URL con
esquema sin que nadie lo note. Está acá, junto al otro hueco, para que se lea con la misma
gravedad y no como nota de informe.

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
