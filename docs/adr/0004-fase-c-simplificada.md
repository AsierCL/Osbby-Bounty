# ADR-0004 — El control de red es de configuración, no de infraestructura

- **Estado**: aceptado. **Sustituye como requisito** a la parte de firewall de ADR-0003.
- **Fecha**: 2026-11-11
- **Specs**: S27 (`Fase C — SIMPLIFICADA, ya no bloqueante por infraestructura de SO`)

## Contexto

ADR-0003 cerraba la vía `bash` con tres capas y exigía una regla de firewall del SO, un usuario
dedicado y, si se quería acotar por usuario, un namespace de red. S27 descarta esa ruta como
requisito: el control que se considera real y suficiente es de configuración.

La razón es de costo/beneficio, no de pereza: una regla `policy drop` en `output` afecta a toda la
máquina, no solo al agente; el namespace de red agrega infraestructura que hay que mantener y
depurar; y el escenario que realmente se quiere evitar es que **el agente de bounty** tenga una vía
libre, no que la máquina esté enjaulada.

## Decisión

1. **Los subagentes de bounty nunca reciben `bash`, shell, fetch ni HTTP libre.** Lo garantiza
   `validateTools()` en `src/pi/runner.ts`, que rechaza esos nombres y cualquier comodín antes de
   spawnear, y lo re-verifica después: si el hijo reporta una tool activa fuera de su allowlist, el
   run se considera fallido. Es una inspección determinista de la lista de tools, no una pregunta al
   modelo (S19a).
2. **Toda acción contra un target pasa por `bounty_run`**, que aplica el gate (canonicalización +
   escaneo genérico de argv), el rate limit del programa y la confirmación en clases destructivas.
3. **`proxy.ts` se queda, con otro rol declarado**: capa de registro y limitación para herramientas
   que hablan HTTP por su cuenta (Burp, Playwright). No es una barrera garantizada.
4. **La regla de firewall de ADR-0003 queda como opción del operador**, no como requisito de la
   herramienta. El documento se mantiene por su valor explicativo.

## Condición de uso (esto va también en el README, en texto claro)

> Este diseño depende de que la sesión de bounty **no comparta contexto** con otra sesión que tenga
> `bash` libre — por ejemplo un agente de coding de propósito general en el mismo workspace. Si las
> dos sesiones conviven, la de coding puede hacer `curl` y el gate no la ve.
>
> Es una **condición de uso**, no un control técnico. La herramienta no puede impedirlo desde
> adentro.

Es la limitación más importante de todo el proyecto y por eso está escrita dos veces.

## Consecuencias

- Si el humano quiere garantía de red además de garantía de configuración, aplica la guía de
  ADR-0003 por su cuenta. La herramienta no la exige ni la detecta.
- El runner gana peso como punto único de verdad: si `validateTools` tiene un hueco, un subagente
  puede recibir una tool que no debería. Por eso tiene tres tests propios, incluido uno que verifica
  que la allowlist misma no contiene ninguna capacidad de shell, fetch o escritura.
- `bounty_run` ejecuta binarios del host. Un binario malicioso no es un problema de alcance sino de
  supply chain: se instala a mano, fuera de la herramienta.

## Pendiente, no bloqueante (S27d)

- **IP resuelta privada/loopback/metadata**: hoy el gate valida el *nombre* y la cadena CNAME, no la
  dirección final. Una regla que permita un nombre que resuelve a `169.254.169.254` pasaría. Mejora
  futura: rechazar respuestas de metadata/loopback cuando el programa no las declare.
- **Pinning anti-TOCTOU**: entre la resolución que valida el gate y la conexión real de la tool hay
  una ventana. Cerrarla requiere que el proxy resuelva y conecte a la IP validada. Mejora futura.

## NO VERIFICADO

1. Que un `pi` hijo real respete `--tools` + `-ne` + `-e` en combinación: los tests usan un `pi`
   falso determinista (S1b). El smoke test real es opt-in y no se ejecutó.
2. Que `ctx.ui.confirm` exista con esa firma en la versión de Pi instalada. El shim cae a "no
   confirmado" si no está, así que el peor caso es una acción destructiva denegada.
3. El comportamiento de `resolveCname` ante un CNAME encadenado en este host.
