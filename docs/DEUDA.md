# Deuda técnica

Registro explícito de lo que se sabe roto o incompleto y **no** se está arreglando ahora, para que
no viva solo en un informe de checkpoint.

## 1. Skills de `gentle-pi` contaminan el contexto de bounty (S46, **resuelto**)

Resuelto en el macrocambio swarm-blackboard: la sesión principal y los hijos arrancan con `-ne -ns`
(sin extensiones ajenas y sin catálogo de skills), y el prompt de dominio documenta las tools nuevas.
Se deja el historial abajo.

Con `-ne` se apagan las **extensiones**, no las **skills** del paquete instalado: la sesión de bounty
sigue viendo el catálogo de skills de desarrollo (branch-pr, judgment-day, skill-creator, …). Las
**tools** sí están restringidas y verificadas; lo que sobra es prompt.

- Riesgo: el agente puede intentar cargar una skill de desarrollo en medio de un programa.
- Mitigación actual: ninguna mecánica; el prompt de dominio no las menciona.
- Arreglo propuesto: filtrar `skills` en el manifiesto del proyecto (`.pi/settings.json` con
  `skills: []` para el paquete) o arrancar con un `--skills` vacío si Pi lo permite.
- No bloqueante para cargar un programa real.

## 2. Host en valor de wordlist no se valida (S44, documentado en docs/gate.md)

Ver la sección "Hueco conocido: wordlists" en `docs/gate.md`. Decisión pendiente: ¿se valida también
ese valor cuando parsea como URL (`https://…`), como ya se hace con `-o`/`-t`/`-w`?

## 3. Pausa destructiva: diálogo verificado, falta el escenario (iii)

**S43 (ii) VERIFICADO** en vivo por el operador: diálogo real de Pi, tecla humana, ambas ramas (NO y
SÍ). Ver `docs/evidence/s43-live-run.md` (R6).

Queda **S43 (iii)**: intentar salir de scope en una sesión viva y ver el mensaje exacto del gate en
`status.md`. El gate está cubierto por tests y por el criterio nuevo del kit, pero no lo vio un humano
en pantalla.

Nota de la corrida: el "incidente" seq 5 de `work/lab-s43-archivo` es un **falso positivo** que quedó
permanente en una cadena que no admite borrado. No se toca: es archivo. Lo que cambió es que ya no
puede volver a pasar (registros de sistema + whitelist de kinds + `erratum` con `refSeq`).

## 4. CVSS v4.0: cerrado, con dos límites (S55: no se reabre sin fuente nueva)

> **Segundo anclaje real-world: no disponible hoy por falta de adopción de NVD.** La validación
> descansa en la tabla oficial de 270 entradas + invariantes (monotonicidad, interpolación) +
> extremos 10.0/0.0.
>
> Marcado como **deuda, no bloqueante**. No se reabre sin una fuente nueva y confirmada. Las guías
> que publican "worked examples" de CVSS v4.0 para CVE famosos suelen autodeclararse
> "analyst-computed, no es documentación oficial de FIRST.org": no son anclajes válidos aunque se vean
> confiables. Cuatro consultas a la API oficial de NVD (`docs/evidence/nvd/`) no devolvieron ninguna
> entrada `cvssMetricV40`, así que el hueco es de adopción, no de implementación.

Implementado y calculando (S42). Límites conocidos, no deuda de cálculo:

- **Métricas modificadas (`M*`) no soportadas**: se rechazan con error en vez de ignorarlas, porque
  ignorarlas cambiaría el score en silencio. Si un programa exige vectores ambientales, hay que
  portarlas.
- **Cobertura de vectores publicados**: los anclajes son los que fija la especificación (0.0 sin
  impacto, 10.0 máximo) más el vector base de Log4Shell (9.3) y las invariantes del algoritmo. Un
  segundo anclaje de CVE real **no está disponible** (ver el recuadro de arriba): deuda cerrada por
  decisión, no pendiente de trabajo.

## 5. Atafetas de test en la extensión (S43, cerrado en lo mecánico por S47)

`GENTLE_BOUNTY_ALLOW_CONFIRM_STUB=1` + `GENTLE_BOUNTY_CONFIRM_TEST=yes|no` permiten responder la
confirmación sin humano, y `GENTLE_BOUNTY_PRELOAD_SCOPE` carga un scope sin pausa.

Desde S47 esto **no puede pasar en el camino normal**: el scope exige `lab: true|false`, el stub solo
responde con `lab: true`, y un alcance real con el stub activo **se niega a cargar** dejando el error
en `status.md`. Queda como atafeta de verificación, con dos variables y log en cada uso.

## 10. `required_headers` con `contains`: Unicode y acentos sin normalizar (S85, abierto, nivel bajo)

La comparación de `mode: contains` es `toLowerCase()` y `includes()`: no normaliza Unicode. Un valor con
acentos o con formas equivalentes (`é` precompuesto vs `e` + combinante), o un header con mayúsculas
turcas, puede no matchear aunque "se vea" igual.

Riesgo: bajo. Afecta solo a programas que exijan un token con acentos dentro de un header, que hoy no
conocemos. No se arregla ahora: si aparece un caso real, la corrección es `normalize("NFC")` (o
`toUpperCase()` con locale fijo) en la comparación, con test del caso concreto.

## 6. El agente explora el repo en vez de cazar (S60, **resuelto**)

Resuelto: `assets/identity.md` + `assets/protocol.md` se inyectan como sección del system prompt y
el protocolo ordena no explorar el repo; la pizarra es el mapa. Se deja el historial abajo.

**Síntoma observado** (tres corridas reales durante S43): en vez de llamar `bounty_run`, el modelo
hizo `ls`, `find` y `read` sobre el repo. Una vez llamó `bounty_run` antes de que el scope terminara
de cargar (bug aparte, ya corregido: el preload se espera).

**Hipótesis principal**: la extensión **registra las tools pero no inyecta el encuadre**. Ni
`assets/identity.md` ni `assets/protocol.md` llegan al system prompt de la sesión: el modelo ve el
preámbulo genérico de Pi ("You are a coding assistant running inside pi…"), siete tools sueltas con
su `description`, y nada que le diga "sos un bounty hunter, toda acción contra un target pasa por
`bounty_run`, no explores el repo". Un agente sin encuadre hace lo que su prompt por defecto le
enseñó: mirar el código.

**Evidencia a favor**: las tools tienen descripciones correctas y aun así el modelo no las usó; cuando
se lo encuadró explícitamente en el prompt del humano, llamó `bounty_run` (una de tres veces, lo que
también sugiere que el encuadre por prompt del usuario no siempre alcanza).

**Arreglo propuesto, NO implementado** (toca el arranque de sesión, no el enforcement):
inyectar `identity.md` + `protocol.md` en el system prompt desde la extensión
(`before_agent_start` con `systemPromptOptions.sections`, o `promptGuidelines` por tool). Antes de
tocarlo quiero el resultado de la prueba manual del humano: si con su encuadre el agente caza bien, el
problema es de prompt y no de diseño de herramientas.

**Por qué no es bloqueante**: las dos líneas rojas se sostienen igual. Un agente que explora no toca
nada fuera de scope ni ejecuta nada destructivo: simplemente no avanza. El costo es tiempo, no
seguridad.

## 7. Campo acordado que no existe en el esquema: puertos por defecto (S58)

Se habló de una política de "puertos por defecto" para el scope. **No existe en el esquema actual**:
los puertos solo aparecen (a) dentro de una regla (`api.acme.com:8443`), o (b) implícitos en un
wildcard, que cubre **todos** los puertos de los nombres que matchea.

Consecuencia práctica: hoy no se puede decir "para `*.acme.com` solo 443 y 8443". Para restringir un
puerto hay que enumerar hosts con puerto y no otorgar el wildcard.

Documentado acá, **sin implementar**, como pidió S58. Si algún día se implementa, el lugar natural es
`limits.allowed_ports` con semántica de intersección con las reglas.

## 8. `httpx` del PATH no es el de Project Discovery (S59)

El preflight avisa: en este host `/usr/bin/httpx` es el **cliente HTTP de Python**, no la herramienta
de Project Discovery. Si algún día se usa `httpx` como binario de recon, hay que verificar cuál está
primero en el PATH. Hoy el flujo del lab usa `curl`, así que no afecta.

## 11. Anotación de la cola: dos casos sin uso real (S95, abierto, nivel bajo)

No bloquean operar; se resuelven con uso real, no con más casos sintéticos.

1. **`financialEffect: "plausible"` en la práctica**: el campo y la regla existen, pero en las corridas
   vistas apareció `"no"` o `"yes"`. Falta verlo aparecer con un importe que *podría* cobrarse y no se
   pudo confirmar.
2. **Colas viejas con booleanos**: el parser lee `true`/`false` como `yes`/`no`, cubierto por código,
   pero no se corrió sobre un archivo real escrito antes de S94.
3. **`approve` justificado en programa real**: no apareció todavía. Es lo esperable —la regla empuja
   `hold`—, pero no está observado.

Qué mirar cuando aparezca: si el anotador usa `"plausible"` sin que la nota explique qué falta
verificar, o si una cola vieja muestra un booleano crudo en `--pending`.

## 9. El verificador firmaba con otro id (encontrado por el flujo vivo)

El primer intento del flujo completo falló en el paso de aplicación: el veredicto era correcto
(`REPRODUCIDO`, con dos ejecuciones reales) pero el código lo rechazó porque la sesión del hijo no
adoptaba el `GENTLE_BOUNTY_SESSION_ID` que genera el runner, así que sus registros de `execution`
llevaban otro id. Corregido en `extensions/bounty.ts`; el segundo intento aplicó el veredicto.
**Deuda**: no hay test unitario de ese cable (solo el flujo vivo lo demostró), porque requiere un
`pi` real. Se cubre con el flujo cuando corra de nuevo.
