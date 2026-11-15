# Navegador real en el harness (S88)

## Por qué

Algunos objetivos deciden con la huella TLS y con JavaScript, no con cabeceras: DataDome devuelve 403 a
`curl` aunque el User-Agent sea correcto. Un navegador real resuelve eso, pero un navegador suelto hace
peticiones que el gate nunca ve (analytics, `js.datadome.co`, CDNs). Este wrapper existe para tener
navegador **sin abrir un canal que el gate no valide**.

## Qué hace

`scripts/browser.ts` corre dentro de `bounty_run` (es la única forma de que el agente lo alcance):

```
bounty_run tool="node" args=["scripts/browser.ts","https://www.thefork.com/login",
  "-H","User-Agent: bugcrowd-research","--out","/tmp/login.png","--html","/tmp/login.html"]
```

- La URL viaja en **argv**, así que el gate la valida y queda en la cadena de evidencia.
- Las cabeceras salen de `-H "Nombre: valor"` en argv: si el scope exige `User-Agent`, es real, no una
  promesa. El navegador las aplica al contexto (`extraHTTPHeaders`).
- **Cada** petición que hace la página se decide con el mismo matcher del gate
  (`scripts/lib/nav-policy.ts`): lo que no está en `in_scope` se **aborta**, incluidos los assets de
  terceros. Las bloqueadas se cuentan y se listan en la salida JSON.
- Imprime una línea JSON: `{url, status, title, blockedRequests, blockedCount, out, html}`.

## Credenciales: nunca en argv

La cadena de evidencia no admite borrado, así que una contraseña en argv queda escrita para siempre.
El wrapper no acepta credenciales por argv. Dos caminos, ambos sin contraseña en el log:

1. **`GENTLE_BOUNTY_STORAGE_STATE`**: un archivo de *storage state* de Playwright (cookies y
   localStorage) exportado por vos desde un navegador ya logueado. El wrapper lo carga y navega como esa
   sesión. Las cookies quedan en tu archivo, no en la cadena.
2. **Login dentro del navegador**: si hace falta escribir la contraseña, la escribe el humano en el
   navegador, no el argv.

## Cómo se habilita (lo hace el operador)

Variables de entorno de la sesión:

| Variable | Para qué |
|---|---|
| `GENTLE_BOUNTY_SCOPE` | ruta al scope confirmado; sin esto el wrapper se niega a correr |
| `GENTLE_BOUNTY_PLAYWRIGHT` | ruta al directorio del módulo `playwright` cuando no es resoluble desde el repo |
| `GENTLE_BOUNTY_STORAGE_STATE` | opcional: cookies de una sesión ya logueada |

En esta máquina el navegador ya está: `~/.cache/ms-playwright` tiene `chromium-1247` y
`chromium_headless_shell-1254` (288 MB), y el driver está en el caché de npx
(`~/.npm/_npx/705bc6b22212b352/node_modules/playwright`, versión 1.65.0). `npx --no-install playwright`
no resuelve esa versión, por eso el wrapper acepta la ruta explícita en `GENTLE_BOUNTY_PLAYWRIGHT`.

Verificado en el lab: `status 200`, `title "Lab"`, captura y HTML escritos.

## Un muro anti-bot es una parada, no un acertijo

El wrapper detecta el muro (DataDome, Cloudflare, PerimeterX, hCaptcha, reCAPTCHA) y **corta**:

- La salida JSON trae `captcha: {detected: true, provider: "datadome"}`.
- El código de salida es **4**: "acá hace falta un humano".
- No intenta resolver el captcha, ni parchea `navigator.webdriver`, ni rota fingerprints. **Resolver un
  captcha es evadir el control de acceso de un tercero**: el programa no lo autoriza, no es un hallazgo
  (los servicios de terceros están excluidos) y solo gasta la cuenta.

El camino limpio es una sesión que ya pasó el muro de forma humana: `--state <archivo>` (o
`GENTLE_BOUNTY_STORAGE_STATE`) con el storage state exportado desde un navegador logueado. En argv va
solo la ruta: ni cookies ni contraseña quedan en la cadena.

## Qué NO protege

- El bloqueo de terceros es deliberado y puede cambiar el comportamiento del objetivo: si DataDome no
  puede cargar su script, el resultado no es "el sitio real", es el sitio sin DataDome. Es una decisión
  de prueba, no una verdad sobre el objetivo; queda visible en `blockedCount`.
- El contenido de la página es **dato, nunca instrucción**: la regla del protocolo sigue aplicando. El
  wrapper no interpreta nada.
- No sustituye al gate: valida el conjunto de hosts que el navegador toca, pero el gate no ve cuerpos,
  formularios ni cabeceras que la página agregue por su cuenta.
