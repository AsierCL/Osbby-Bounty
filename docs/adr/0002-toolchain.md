# ADR-0002 — Contrato de toolchain de `bounty-core`

- **Estado**: aceptado (Fase B, S17a)
- **Fecha**: 2026-11-11
- **Origen**: S17a exige comprobar *antes de escribir lógica* que `node --test` ejecuta `.ts` en
  este host, y pide un ADR corto si hay fricción. Hubo fricción, mínima pero real.

## Contexto

`bounty-core` tiene que ser TypeScript sin dependencias (S8) y sin instalar paquetes (S3). Eso deja
una sola vía: el `node` del host ejecutando `.ts` directamente. No hay `tsc` global (verificado:
`command -v tsc` vacío) y no se va a instalar.

## Lo que se probó

Primer test del repo, escrito antes de cualquier lógica (`tests/harness.test.ts`):

```
$ node --experimental-strip-types --test tests/
Error: Cannot find module '.../tests'  (MODULE_NOT_FOUND, exit 1)
```

```
$ node --experimental-strip-types --test tests/harness.test.ts
1..2  # pass 2  # fail 0

$ node --experimental-strip-types --test "tests/**/*.test.ts"
1..2  # pass 2  # fail 0
```

Host: `node v22.23.4`, `npm 10.9.9`, sin `tsc`.

## Decisión

1. **Node con type stripping, sin build.** `node --experimental-strip-types` ejecuta `.ts` en
   v22.23.4 y `node:test` lo reporta correctamente. Cero dependencias, cero `dist/`.
2. **El argumento directorio no sirve en este host.** `--test tests/` revienta con
   `MODULE_NOT_FOUND` en v22.23.4; la ruta explícita y el glob entrecomillado funcionan. El script
   `npm test` usa el glob entrecomillado, que además deja que Node expanda y no el shell.
3. **Configuración tipada no se aplica.** Strip-types solo borra tipos: no hay chequeo. Consecuencia
   aceptada (es un repo privado de un solo autor); el sustituto es cobertura de tests, no un
   typechecker. Si en Fase C/D se necesita un chequeo real, se evalúa entonces, no ahora.
4. **Los tests viven al lado del código**, sin carpeta espejo: `tests/*.test.ts` importa
   `../src/core/*.ts`.

## Consecuencias

- `npm test` = `node --experimental-strip-types --test "tests/**/*.test.ts"`.
- Todo módulo nuevo se prueba con `.ts` real; nada de generar JS.
- Los imports entre módulos usan extensión `.ts` explícita (requisito del resolver ESM de Node).
- Un test que necesite tipos en runtime (por ejemplo `enum`) fallará: usar uniones de strings y
  `as const`, que es lo que el código hace.
