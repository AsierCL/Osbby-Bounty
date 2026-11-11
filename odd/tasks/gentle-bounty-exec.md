# gentle-bounty — ejecución del plan v2

Feature: implementación de `gentle-bounty` (infraestructura de control para bug bounty sobre Pi),
en tres cortes verticales con checkpoint humano. Trabajo en curso desde Fase A.
Repo de la herramienta: `/home/opencode-agent/GentleBounty/gentle-bounty`.

## Specs

Normativas. Citan el pedido del usuario palabra por palabra; no se resumen ni se amplían.

### S1 — Alcance de red durante todo el trabajo

```
1. Durante TODO este trabajo, el único tráfico de red permitido es hacia localhost y laboratorios
   locales propios (Juice Shop, VAmPI, crAPI o similares). Ningún host real, ningún scope file de
   un programa real, ninguna llamada a servicios de terceros desde las pruebas.
```

### S2 — Nada de exploits

```
2. No escribas exploits ni payloads ofensivos. Construyes infraestructura de control (scope, gate,
   evidencia, informes, orquestación). Los playbooks son metodología de verificación, no código de
   ataque.
```

### S3 — Terceros solo lectura

```
3. Del código de terceros que revises: solo lectura. No ejecutes scripts de instalación, no
   instales paquetes de repos externos en el host, no copies nada sin comprobar su licencia.
```

### S4 — Secretos fuera del repo

```
4. Secretos fuera del repo. scope/ y work/ siempre en .gitignore.
```

### S5 — Engram fuera de alcance

```
5. No intentes arreglar Engram. Está fuera de alcance (D10: filesystem primero).
```

### S6 — Honestidad de verificación

```
6. Marca como NO VERIFICADO todo lo que no hayas comprobado directamente. No presentes
   suposiciones como hechos.
```

### S7 — Decisiones cerradas

```
- Q5: nombre de trabajo gentle-bounty. No inviertas tiempo en renombrar.
- Q6: el code review de programas con código fuente queda para después de F6.
- Q7: el primer playbook completo es API + autorización (IDOR/BOLA y JWT).
```

### S8 — C1: núcleo sin Pi

```
C1. El núcleo es una librería TypeScript SIN dependencias de Pi (bounty-core): scope, gate,
    rate limiter, evidencia con cadena de hashes, redactor. Testeable sin LLM. La extensión de Pi
    es un adaptador fino encima.
```

### S9 — C2: enforcement de red

```
C2. Capa de red bajo el chokepoint: proxy de salida propio (allowlist de hosts, token bucket por
    host, log) y diseño de enforcement a nivel SO (usuario dedicado + regla de firewall que solo
    permita salir al proxy). Todo lo que emita tráfico (bounty_run, Burp, Playwright) pasa por él.
    Esto cierra la vía bash del Anexo A: documenta la decisión en un ADR.
```

### S10 — C3: el gate valida lo que se contacta

```
C3. El gate valida lo que realmente se contacta, no solo el campo target:
    - cada host dentro de listas (-l archivo), recon pasivo incluido;
    - hosts escondidos en argv (cabeceras Host, plantillas con callbacks OOB);
    - redirects (desactivados o re-validados en cada salto);
    - resolución DNS y CNAME hacia terceros.
```

### S11 — C4: redacción en código

```
C4. La redacción de datos hacia el modelo se implementa en código: bounty_run devuelve una vista
    redactada (sin Cookie/Authorization/tokens, cuerpos truncados); el crudo va al evidence store.
    opsec-target queda como skill fina de apoyo.
```

### S12 — C5: scope YAML ampliado

```
C5. Scope YAML ampliado: required_headers, y un campo de política de automatización / reportes
    asistidos por IA del programa.
```

### S13 — C6: dos modos

```
C6. Dos modos de ejecución: propose (un humano aprueba cada acción activa) y auto (dentro del
    gate). Arranca siempre en propose.
```

### S14 — C7: reportes y CVSS

```
C7. Reportes: un solo formato canónico + checklist genérica. Validadores por plataforma después.
    CVSS v4.0 implementado según la especificación oficial, con vectores de referencia en los tests.
```

### S15 — C8: no forkar todavía

```
C8. D1 (fork): NO forkees todavía. Primero el spike de la fase A.
```

### S16 — Fase A

```
FASE A — Spike de empaquetado (máx. 1 día)
  Comprueba si gentle-bounty puede ser un paquete Pi independiente (extensión bounty.ts + assets +
  agentes + skills) que conviva con gentle-pi/gentle-ai sin copiar su motor. Entregable: ADR con
  evidencia (path:line) y recomendación: paquete aparte, o fork con F0. Si el resultado es
  ambiguo, para y pregunta.
```

### S17 — Fase B

```
FASE B — bounty-core
  Scope parser y matcher, normalización de targets, gate, rate limiter por host, evidencia
  encadenada, redactor. Suite de tests adversarial para el gate: confusión de userinfo
  (acme.com@otro), punycode/homógrafos, punto final, mayúsculas, IPv6, IPs en decimal/octal,
  puertos, semántica de *.dominio vs apex, dominio.com.otro.com, redirects, CNAME a terceros,
  y unknown ⇒ rechazo. Usa tests basados en propiedades donde tenga sentido.
  Criterio: nada fuera de scope pasa; una entrada alterada rompe la cadena y verify lo detecta.
```

### S18 — Fase C

```
FASE C — Enforcement de red
  Proxy de salida propio + ADR de cierre de la vía bash + prueba demostrable de que un curl desde
  el agente no sale. Entrega la guía de instalación de la regla de firewall (sin aplicarla tú).
```

### S19 — Fase D

```
FASE D — Adaptador Pi (según el ADR de A)
  Tools: bounty_scope, bounty_run, bounty_evidence, bounty_finding, bounty_phase. Subagentes con
  allowlist de tools, ninguno con bash genérico. Protocolo de 7 fases en assets. Regla de datos
  del target = datos, nunca instrucciones.
```

### S20 — Fase E

```
FASE E — Corte vertical contra laboratorio local
  Un recorrido completo: scope → recon → hipótesis → validación → finding verificado por un
  verificador independiente → CVSS → reporte. Incluye pruebas negativas obligatorias:
  (1) el agente intenta salir de scope y es bloqueado; (2) una página del laboratorio con
  instrucciones plantadas (prompt injection) se trata como dato y se registra como observación.
```

### S21 — Fase F

```
FASE F — Skills y prior art (puede avanzar en paralelo desde B)
  Revisión en solo lectura, con límite de tiempo, de lo que ya existe. Candidatos conocidos (no
  verificados por ti): Pentest Agent Suite (github.com/H-mmer/pentest-agents; ojo: licencia
  NOASSERTION), claude-bug-bounty (shuvonsec), Claude-BugHunter, el bundle bug-bounty de
  elementalsouls, y trailofbits/skills. Para cada uno: licencia, qué cubre, si hace enforcement
  de scope o cadena de evidencia (verifícalo en el código), y riesgos de supply chain o de
  instrucciones sospechosas dentro de las skills. Salida: docs/prior-art.md con qué adaptar y
  qué no. Escribe tú solo scope-guard, poc-minimal, opsec-target y el playbook API+authz.
```

### S22 — Checkpoints e informe

```
## Checkpoints (para y espera mi aprobación en cada uno)
  1. Tras la fase A (ADR de empaquetado).
  2. Tras B+C (gate y enforcement, con resultados de tests).
  3. Tras E (corte vertical). Solo después se discute apuntar a un programa real, y siempre en
     modo propose.

## Formato de cada informe de checkpoint
Qué se hizo; qué tests pasan (y cuáles no); decisiones tomadas con su ADR; lo NO VERIFICADO;
riesgos nuevos; qué necesitas de mí.
```

## Tasks

| ID | Tarea | Spec | Ruta | Commit |
|----|-------|------|------|--------|
| T1 | Bootstrap del repo de la herramienta, `.gitignore` con `scope/` y `work/`, task doc | S4 | inline | `chore(repo): bootstrap gentle-bounty and ODD task document` |
| T2 | Fase A: spike de empaquetado, `docs/adr/0001-empaquetado.md` con evidencia `path:line` y recomendación | S15, S16 | inline | `docs(adr): record packaging spike result` |
| T3 | Checkpoint 1 al usuario | S22 | inline | — |
| T4 | Fase B: `bounty-core` normalización de targets + parser de scope + matcher | S8, S10, S12, S17 | worker | `feat(core): scope parser, target normalization and matcher` |
| T5 | Fase B: gate que decide sobre lo que se contacta (listas, argv, redirects, DNS/CNAME) | S10, S17 | worker | `feat(core): scope gate over contacted hosts` |
| T6 | Fase B: rate limiter por host (token bucket) | S8, S17 | worker | `feat(core): per-host token bucket rate limiter` |
| T7 | Fase B: evidence store append-only con cadena de hashes + `verify` | S8, S17 | worker | `feat(core): hash-chained evidence store` |
| T8 | Fase B: redactor de vistas hacia el modelo | S11, S17 | worker | `feat(core): redact request/response views for the model` |
| T9 | Fase B: suite adversarial del gate + property tests | S17 | worker | `test(core): adversarial gate suite` |
| T10 | Checkpoint 2 (gate + enforcement, con resultados de tests) | S22 | inline | — |
| T11 | Fase C: proxy de salida (allowlist, token bucket, log) | S9, S18 | worker | `feat(proxy): egress proxy with host allowlist and log` |
| T12 | Fase C: ADR de cierre de la vía `bash` + guía de firewall (sin aplicarla) | S9, S18 | inline | `docs(adr): close the bash egress path` |
| T13 | Fase D: adaptador Pi (`bounty_scope`, `bounty_run`, `bounty_evidence`, `bounty_finding`, `bounty_phase`), subagentes sin `bash`, protocolo de 7 fases, modo `propose` por defecto | S13, S19 | worker | `feat(pi): thin Pi adapter over bounty-core` |
| T14 | Fase E: corte vertical completo contra laboratorio local | S20 | inline | `test(e2e): vertical slice against local lab` |
| T15 | Fase E: pruebas negativas — escape de scope bloqueado y prompt injection tratada como dato | S20 | inline | `test(e2e): scope escape and prompt injection negatives` |
| T16 | Fase F: `docs/prior-art.md` (licencia, cobertura, enforcement, cadena de evidencia, riesgos) | S3, S21 | worker | `docs(prior-art): third-party bounty assets review` |
| T17 | Fase F: skills propias `scope-guard`, `poc-minimal`, `opsec-target` y playbook API+authz | S2, S11, S21, S7 | worker | `feat(skills): bounty skills and API authz playbook` |
| T18 | Checkpoint 3 (corte vertical) | S22 | inline | — |

## Log

### L1 — Pedido original (verbatim)

```text
# MISIÓN: ejecutar el plan gentle-bounty (v2, con cambios)

Contexto: ya redactaste PLAN-MAESTRO-gentle-bounty.md. Ahora pasas a ejecución. Este prompt
corrige y prioriza ese plan. Si algo choca con el plan, gana este prompt. Sigue tu disciplina
ODD: crea odd/tasks/gentle-bounty-exec.md con specs S# que citen este prompt literalmente,
tareas T#, log L#; un commit por unidad de trabajo en el repo de la herramienta; línea "Risk:"
en cada cambio.

## Reglas duras (no negociables)
1. Durante TODO este trabajo, el único tráfico de red permitido es hacia localhost y laboratorios
   locales propios (Juice Shop, VAmPI, crAPI o similares). Ningún host real, ningún scope file de
   un programa real, ninguna llamada a servicios de terceros desde las pruebas.
2. No escribas exploits ni payloads ofensivos. Construyes infraestructura de control (scope, gate,
   evidencia, informes, orquestación). Los playbooks son metodología de verificación, no código de
   ataque.
3. Del código de terceros que revises: solo lectura. No ejecutes scripts de instalación, no
   instales paquetes de repos externos en el host, no copies nada sin comprobar su licencia.
4. Secretos fuera del repo. scope/ y work/ siempre en .gitignore.
5. No intentes arreglar Engram. Está fuera de alcance (D10: filesystem primero).
6. Marca como NO VERIFICADO todo lo que no hayas comprobado directamente. No presentes
   suposiciones como hechos.

## Decisiones cerradas
- Q5: nombre de trabajo gentle-bounty. No inviertas tiempo en renombrar.
- Q6: el code review de programas con código fuente queda para después de F6.
- Q7: el primer playbook completo es API + autorización (IDOR/BOLA y JWT).

## Cambios al plan
C1. El núcleo es una librería TypeScript SIN dependencias de Pi (bounty-core): scope, gate,
    rate limiter, evidencia con cadena de hashes, redactor. Testeable sin LLM. La extensión de Pi
    es un adaptador fino encima.
C2. Capa de red bajo el chokepoint: proxy de salida propio (allowlist de hosts, token bucket por
    host, log) y diseño de enforcement a nivel SO (usuario dedicado + regla de firewall que solo
    permita salir al proxy). Todo lo que emita tráfico (bounty_run, Burp, Playwright) pasa por él.
    Esto cierra la vía bash del Anexo A: documenta la decisión en un ADR.
C3. El gate valida lo que realmente se contacta, no solo el campo target:
    - cada host dentro de listas (-l archivo), recon pasivo incluido;
    - hosts escondidos en argv (cabeceras Host, plantillas con callbacks OOB);
    - redirects (desactivados o re-validados en cada salto);
    - resolución DNS y CNAME hacia terceros.
C4. La redacción de datos hacia el modelo se implementa en código: bounty_run devuelve una vista
    redactada (sin Cookie/Authorization/tokens, cuerpos truncados); el crudo va al evidence store.
    opsec-target queda como skill fina de apoyo.
C5. Scope YAML ampliado: required_headers, y un campo de política de automatización / reportes
    asistidos por IA del programa.
C6. Dos modos de ejecución: propose (un humano aprueba cada acción activa) y auto (dentro del
    gate). Arranca siempre en propose.
C7. Reportes: un solo formato canónico + checklist genérica. Validadores por plataforma después.
    CVSS v4.0 implementado según la especificación oficial, con vectores de referencia en los tests.
C8. D1 (fork): NO forkees todavía. Primero el spike de la fase A.

## Fases (corte vertical; cada una cierra con tests y doc)

FASE A — Spike de empaquetado (máx. 1 día)
  Comprueba si gentle-bounty puede ser un paquete Pi independiente (extensión bounty.ts + assets +
  agentes + skills) que conviva con gentle-pi/gentle-ai sin copiar su motor. Entregable: ADR con
  evidencia (path:line) y recomendación: paquete aparte, o fork con F0. Si el resultado es
  ambiguo, para y pregunta.

FASE B — bounty-core
  Scope parser y matcher, normalización de targets, gate, rate limiter por host, evidencia
  encadenada, redactor. Suite de tests adversarial para el gate: confusión de userinfo
  (acme.com@otro), punycode/homógrafos, punto final, mayúsculas, IPv6, IPs en decimal/octal,
  puertos, semántica de *.dominio vs apex, dominio.com.otro.com, redirects, CNAME a terceros,
  y unknown ⇒ rechazo. Usa tests basados en propiedades donde tenga sentido.
  Criterio: nada fuera de scope pasa; una entrada alterada rompe la cadena y verify lo detecta.

FASE C — Enforcement de red
  Proxy de salida propio + ADR de cierre de la vía bash + prueba demostrable de que un curl desde
  el agente no sale. Entrega la guía de instalación de la regla de firewall (sin aplicarla tú).

FASE D — Adaptador Pi (según el ADR de A)
  Tools: bounty_scope, bounty_run, bounty_evidence, bounty_finding, bounty_phase. Subagentes con
  allowlist de tools, ninguno con bash genérico. Protocolo de 7 fases en assets. Regla de datos
  del target = datos, nunca instrucciones.

FASE E — Corte vertical contra laboratorio local
  Un recorrido completo: scope → recon → hipótesis → validación → finding verificado por un
  verificador independiente → CVSS → reporte. Incluye pruebas negativas obligatorias:
  (1) el agente intenta salir de scope y es bloqueado; (2) una página del laboratorio con
  instrucciones plantadas (prompt injection) se trata como dato y se registra como observación.

FASE F — Skills y prior art (puede avanzar en paralelo desde B)
  Revisión en solo lectura, con límite de tiempo, de lo que ya existe. Candidatos conocidos (no
  verificados por ti): Pentest Agent Suite (github.com/H-mmer/pentest-agents; ojo: licencia
  NOASSERTION), claude-bug-bounty (shuvonsec), Claude-BugHunter, el bundle bug-bounty de
  elementalsouls, y trailofbits/skills. Para cada uno: licencia, qué cubre, si hace enforcement
  de scope o cadena de evidencia (verifícalo en el código), y riesgos de supply chain o de
  instrucciones sospechosas dentro de las skills. Salida: docs/prior-art.md con qué adaptar y
  qué no. Escribe tú solo scope-guard, poc-minimal, opsec-target y el playbook API+authz.

## Checkpoints (para y espera mi aprobación en cada uno)
  1. Tras la fase A (ADR de empaquetado).
  2. Tras B+C (gate y enforcement, con resultados de tests).
  3. Tras E (corte vertical). Solo después se discute apuntar a un programa real, y siempre en
     modo propose.

## Formato de cada informe de checkpoint
Qué se hizo; qué tests pasan (y cuáles no); decisiones tomadas con su ADR; lo NO VERIFICADO;
riesgos nuevos; qué necesitas de mí.

## Empieza ahora
Crea el task doc con las specs S# citando este prompt y arranca la fase A.
```

### L2 — Interpretación de S1 respecto de la Fase F

S1 prohíbe todo tráfico que no sea localhost/labs. S21 pide revisar repos de terceros en GitHub,
lo cual es tráfico hacia un host real. Resolución adoptada: S1 se aplica al tráfico **del producto y
de sus pruebas** (nada de hosts reales, nada de escaneo), y la lectura de código público para
`docs/prior-art.md` se hace con `git clone`/fetch de solo lectura de los repos nominalmente
listados en S21, sin ejecutar nada suyo (S3). Queda como supuesto declarado, no como hecho: si el
usuario prefiere que la Fase F se haga solo con material ya presente en disco, se ajusta antes de
T16.

### L3 — Decisiones de la Fase A

- La Fase A se ejecutó 100% offline, leyendo Pi (`docs/`) y `gentle-pi` instalados en el host. Cero
  red.
- Resultado del spike y recomendación: `docs/adr/0001-empaquetado.md`.
- No se ejecutó ni instaló código de terceros (S3). No se intentó cargar `gentle-agents.ts` en un
  perfil descartable porque eso ejecutaría código de `gentle-pi` fuera de su entorno declarado y
  no es necesario para el ADR: la evidencia estática alcanza y lo que falta quedó marcado como
  NO VERIFICADO.

### L4 — Cierre de Fase A

- T1 y T2 cerradas. Entregable: `docs/adr/0001-empaquetado.md`.
- Resultado del spike: **no ambiguo**. Recomendación adoptada: paquete Pi independiente
  (`gentle-bounty`) sin dependencia de `gentle-pi`, con runner de subagentes propio y mínimo.
  Fork descartado por ahora (respeta C8/S15).
- Consecuencia registrada: la Fase D incluye un runner nuevo (~300-400 líneas estimadas, NO
  VERIFICADO como medida real).
- Se sigue en Checkpoint 1: no se abre Fase B hasta aprobación (S22).
