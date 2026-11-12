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
