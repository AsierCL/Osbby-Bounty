# Prior art y código de terceros

Registro obligatorio de S21a: nada de terceros entra al producto sin licencia comprobada y registrada
acá.

## Vendoreado (datos, no código)

### `FIRSTdotorg/cvss-v4-calculator` — BSD-2-Clause

- **Qué se tomó**: las tres tablas de datos del cálculo CVSS v4.0 (`cvss_lookup.js`,
  `max_severity.js`, `max_composed.js`), convertidas a literales TypeScript en
  `src/core/cvss-data.ts`. **No** se copió código de la aplicación: el algoritmo está porteado a mano
  en `src/core/cvss.ts` a partir de la especificación y de la lectura del original.
- **Licencia**: BSD-2-Clause. Copyright (c) 2023 FIRST.ORG, Inc., Red Hat, and contributors.
- **Cómo se obtuvo**: `git clone --depth 1 --no-recurse-submodules -c core.hooksPath=/dev/null` en
  `../prior-art/cvss-v4-calculator` (fuera de este repo), solo lectura, sin ejecutar nada de lo
  clonado, como manda S21a.
- **Autorización**: repo **no** listado en Fase F. El humano autorizó explícitamente su uso para S42
  (decisión registrada en el checkpoint 4 → 5).
- **Requisito de la licencia**: conservar el aviso de copyright y la licencia en la redistribución.
  Está en la cabecera de `src/core/cvss-data.ts` y en este archivo. Si el paquete se distribuye fuera
  de esta máquina, hay que incluir el texto completo de BSD-2-Clause.

| Archivo | Origen | Tamaño |
|---|---|---|
| `src/core/cvss-data.ts` | tablas de lookup, severidad máxima y vectores máximos compuestos | ~6 KB |

## Revisión de Fase F (S45/S49) — solo lectura, nada incorporado

Clonados con `git clone --depth 1 --no-recurse-submodules -c core.hooksPath=/dev/null` en
`../prior-art/`, **sin ejecutar nada** de lo clonado (ni install, ni tests, ni scripts).

### `shuvonsec/claude-bug-bounty` — MIT

- **Qué cubre**: playbooks de caza (26 `SKILL.md`, 209 `.md`), comandos, un MCP server propio en Go y
  un conjunto de tests que incluye `test_scope_checker.py`, `test_agent_dispatcher_scope.py` y
  `test_false_positives.py`.
- **Enforcement de scope / cadena de evidencia**: tiene **verificación de scope en código** (tests
  dedicados y selector de targets) y tests de falsos positivos. **No** vi cadena de hashes ni
  puntero de cabeza: la evidencia es archivos, no una cadena verificable.
- **Riesgos**: el `README` incluye `curl -fsSL https://ollama.ai/install.sh | sh`. Es exactamente lo
  que S3/S21a prohíben ejecutar; si alguien sigue el README a ciegas, instala un binario con `| sh`.
  El resto de los hits de grep son contenido técnico (payloads, writeups), no instrucciones al agente.
- **Qué adaptar**: la lista de límites duros de `rules/hunting.md` es casi idéntica a nuestras dos
  líneas rojas y sirve como **validación externa** del diseño. Los nombres de clases y la estructura
  de skills (una por clase de vulnerabilidad) son buen molde para nuestras skills propias.
- **Qué NO adaptar**: sus scripts y su MCP server (no los necesitamos: nuestro gate es el chokepoint),
  y nada de su prosa sin atribución MIT.

### `H-mmer/pentest-agents` — **sin licencia** (NOASSERTION)

- **Qué cubre**: el más grande de los cuatro (306 `SKILL.md`, 567 `.md`, 75 scripts), con hooks,
  `mcp-bounty-server`, `mcp-writeup-server`, `rag-builder` y `rules/`.
- **Enforcement de scope / cadena de evidencia**: sí hay enforcement real, con tests
  (`tests/test_scope_check.py`, `tests/test_autopilot_gate.py`) y modelos en `mcp-bounty-server`.
  Cadena de evidencia verificable: **no la vi**.
- **Riesgos**: **sin archivo de licencia**. Sin licencia, el valor por defecto es "todos los derechos
  reservados": **no se copia ni un fragmento**. Además, 75 scripts y hooks ajenos son superficie de
  supply chain que no vamos a incorporar.
- **Qué adaptar**: **nada de código**. Sirve como referencia de diseño: el concepto de "autopilot
  gate" es el mismo que nuestro modo automático con pausas, y confirma que la separación
  scope-check / ejecución es la forma correcta.
- **Qué NO adaptar**: todo lo demás, por licencia.

### No resueltos (necesito la URL exacta)

- `vavkamil/Claude-BugHunter` → **404**, no existe o el nombre/owner es otro.
- `elementalsouls/Claude-Bug-Bounty` → **404**, idem.

S21a prohíbe ampliar la lista de repos sin OK, así que no voy a adivinar owners. Con la URL exacta,
los reviso igual que los otros dos.

## Revisado pero no incorporado

### `trailofbits/skills` — verificado en Fase 0 (solo lectura)

Plugins en formato Claude-plugin con `SKILL.md`. Candidatos útiles para más adelante
(`cvss-scoring`, `fp-check`, `vulnerability-triage-brocards`, `variant-analysis`). **Nada copiado.**
La revisión formal de Fase F (S45) sigue pendiente: licencia por plugin, cobertura, si hacen
enforcement de scope, y riesgo de instrucciones sospechosas dentro de las skills.

## Pendiente (Fase F, S45)

- `H-mmer/pentest-agents` (licencia NOASSERTION: **no** tocar sin revisar términos)
- `shuvonsec/claude-bug-bounty`
- `Claude-BugHunter`
- bundle `bug-bounty` de `elementalsouls`

Regla que no se negocia: se leen, no se ejecutan; se copia solo con licencia registrada acá.
