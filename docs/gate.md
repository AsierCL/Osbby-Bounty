# El gate: orden de decisión y consecuencias documentadas

`src/core/gate.ts` es el único punto donde se decide si una acción toca la red. Este documento fija
el orden de las decisiones y las dos consecuencias incómodas que se aceptan a propósito.

## Orden de decisión

Una acción se deniega en el primer chequeo que falla. No hay "warn and continue".

1. **Método** en la allowlist del programa (`limits.allowed_methods`). Lista vacía = sin restricción.
2. **Técnica** prohibida (`limits.forbidden`), por ejemplo `dos` o `brute-force`.
3. **Redirects**: si se piden y la política es `reject`, se deniega. Con `revalidate`, se permite y
   se emite la nota de que **cada salto debe re-validarse**.
4. **Headers obligatorios** del programa (`required_headers`): se comparan contra los headers que la
   petición **envía de verdad** (`-H`/`--header`). Un valor simple exige coincidencia exacta; la forma
   `{value, mode: contains}` exige que el valor contenga el texto (Bugcrowd pide "bugcrowd" dentro del
   User-Agent).

   **Qué pasó con S79, para que no se repita**: el chequeo existía, pero era **vacuo**. La sesión le
   pasaba al gate el requisito como si fueran los headers de la petición, así que el gate comparaba el
   requisito consigo mismo y **nunca podía fallar**: cualquier corrida pasaba, mandara o no el header.
   Un chequeo que no se vio fallar nunca no está probado. El test que lo prueba de verdad es el que
   corre sin el header y exige que **no se ejecute** (`tests/required-headers.test.ts:69`, "sin header ⇒
   no ejecuta"); los tests de "presente ⇒ pasa" no distinguen un chequeo real de uno vacuo.
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

## CNAME, CDN y la IP final (S87)

Un host en scope que resuelve por CNAME a infraestructura compartida (`www.thefork.com` →
`thefork.map.fastly.net`, un ELB de AWS) **no está saliendo del scope**: la petición sigue saliendo con
el Host/SNI del nombre que sí está en scope.

**Lo que se quitó**: exigir que el **nombre** del salto CNAME estuviera él mismo en `in_scope`. Eso
bloqueaba casi cualquier sitio de producción real detrás de un CDN o balanceador, y era un falso
negativo (denegaba tráfico legítimo). El nombre de un salto CNAME se exime si termina en un sufijo de
infraestructura compartida conocida (`SHARED_INFRASTRUCTURE_SUFFIXES` en `src/core/gate.ts`: `fastly.net`,
`cloudfront.net`, `akamaiedge.net`, `akamai.net`, `akamaized.net`, `edgekey.net`, `edgesuite.net`,
`elb.amazonaws.com`, `cloudflare.net`, `azureedge.net`, `trafficmanager.net`, `googleusercontent.com`).
Un CNAME a cualquier **otro** dominio que no esté en scope sigue denegándose: eso puede ser un
subdominio apuntando a algo que el objetivo ya no controla, y es un hallazgo real.

**Lo que se mantiene y ahora se implementa de verdad**: la pregunta que protege es **a qué dirección se
llega**, no cómo se llama el salto intermedio. El gate resuelve y comprueba la IP final: loopback,
RFC1918, CGNAT, ULA (`fc00::/7`), link-local (`169.254/16`, `fe80::/10`), no especificada, IPv4 mapeada
en IPv6, y las direcciones de metadatos de nube (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`,
`fd00:ec2::254`) se **deniegan** aunque el nombre del CNAME esté en la lista de proveedores. La lista de
proveedores exime el nombre; no exime la dirección.

Antes de S87 esta comprobación de IP **no existía**: `DnsAnswer.addresses` se recibía y no se miraba, y
el chequeo de nombre de CNAME era lo único que había. Un nombre en scope que resolviera a
`169.254.169.254` pasaba sin más. Por eso esto no es una relajación: es corregir qué pregunta se hace.

**Excepción acotada**: un scope con `lab: true` puede declarar `allow_private: true` para apuntar a
redes privadas propias (el laboratorio). Con `lab: false` la clave es un error de carga: un programa real
no resuelve a direcciones internas. Y una IP literal declarada en `in_scope` no se vuelve a juzgar por su
rango: es una declaración explícita del operador, y así funcionan los labs.

## Headers: destino de conexión vs entrada de prueba (S81)

Un valor de header se trata como **destino de conexión** solo si de verdad tiene forma de host: URL con
esquema, host con punto, IP, `localhost` o IPv6 entre corchetes, con puerto opcional. Antes de S81 la
extracción de `header-host` no aplicaba esa guarda (el escaneo general de argv sí), así que
`-H "Origin: null"` se convertía en el host `null` y la corrida se denegaba por un host fuera de scope
al que nadie iba a conectarse.

**Headers de prueba, nunca de enrutamiento** — el gate **no** los valida contra el scope, porque el
servidor los usa para decidir *qué devuelve*, no *a dónde se conecta*:

| Header | Para qué se prueba |
|---|---|
| `Origin` | CORS: `null`, un origen arbitrario, un origen atacante |
| `Referer` | CORS/CSRF y comprobaciones de origen |

Todo lo demás sigue validándose igual que antes. En particular, estos pueden decidir el destino real
(SSRF) y un valor ajeno **bloquea**:

| Header | Por qué |
|---|---|
| `Host` | Es el host virtual que el servidor atiende |
| `X-Forwarded-Host`, `X-Forwarded-Server` | Los proxies los usan para enrutar |
| `X-Forwarded-For` | Identidad de origen para el enrutamiento y los controles |
| `Forwarded` | Forma estandarizada de los anteriores |

Y una URL metida en **cualquier otro** header (por ejemplo un callback propio) la sigue encontrando el
escaneo genérico de argv: la excepción es una lista cerrada de dos nombres, no una puerta abierta.

Los headers de prueba quedan anotados como omitidos en el resultado del gate, para que la evidencia
muestre por qué no se validaron.

Dentro de una línea de header (`Nombre: valor`) el texto que sigue a un `=` es **valor de header**, no
un host desnudo: una cookie como `session=abc.def` se leía como el host `abc.def` y bloqueaba la
corrida. Una URL con esquema dentro de cualquier header sigue bloqueando, porque la encuentra el escaneo
genérico.

## Mutaciones GraphQL: siempre pausan (S81)

Una petición con `mutation` en el cuerpo GraphQL cambia estado, así que se clasifica como destructiva
y pasa por la pausa de confirmación, igual que `hydra`. Cuenta cuando:

- `Content-Type: application/json` o `application/graphql` (con o sin `charset`) **y** el cuerpo trae
  `mutation` fuera de comentarios (`# …`); o
- el cuerpo es GraphQL crudo que empieza con `mutation`; o
- el cuerpo es un JSON de GraphQL (`{"query": "mutation …"}` / `operationName`).

**Limitación, explícita**: no se detectan por nombre las mutaciones con efecto financiero (`buy`, `pay`,
`transfer`) ni los endpoints REST que mutan sin decir "mutation". La regla es una red por **forma**,
no un juicio: lo que parece inocuo igual pausa, y lo que no dice "mutation" depende del criterio del
modelo. La clase reportada es `graphql-mutation`, y puede caer en la lista `forbidden` de un programa.

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

## Campo obligatorio `lab` (S47)

El scope declara si el objetivo es un laboratorio propio o un programa real:

```yaml
program: lab
lab: true          # true = laboratorio propio; false = programa real
```

Sin `lab` el scope **no carga** (falla cerrado, como todo lo demás). El valor solo puede ser
`true` o `false`.

Para qué sirve: las atafetas de test de la confirmación (`GENTLE_BOUNTY_ALLOW_CONFIRM_STUB` +
`GENTLE_BOUNTY_CONFIRM_TEST`) **solo tienen efecto con `lab: true`**. Si están definidas y el scope
es `lab: false`, la sesión **se niega a cargar el alcance** y lo deja escrito en `status.md`. La
segunda barrera: aunque algo saltara esa puerta, `resolveConfirm` no deja que el stub responda fuera
de un lab.

## Anclaje del CVSS (S55)

El score del reporte se calcula con la tabla oficial de CVSS v4.0 vendoreada de FIRST. **Segundo
anclaje real-world: no disponible hoy por falta de adopción de NVD**; la validación descansa en la
tabla oficial de 270 entradas + invariantes (monotonicidad, interpolación) + extremos 10.0/0.0. Es
deuda marcada, no bloqueante, y no se reabre sin una fuente nueva y confirmada. Detalle y evidencia
de las consultas a NVD: `docs/DEUDA.md` §4 y `docs/evidence/nvd/`.

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
