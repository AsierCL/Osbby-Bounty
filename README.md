# gentle-bounty

Infraestructura de control para bug bounty sobre Pi: scope, gate de ejecución, rate limiting,
evidencia con cadena de hashes, redacción y reportes.

**Estado: Fase A (spike de empaquetado). Nada funcional todavía.**

- Núcleo: `bounty-core`, TypeScript sin dependencias de Pi ni de terceros. Testeable sin LLM.
- Adaptador: extensión Pi fina encima del núcleo.
- Alcance de pruebas: **solo localhost y laboratorios locales propios**. Sin hosts reales.

Documentación:

- `odd/tasks/gentle-bounty-exec.md` — especificación y tracking del trabajo (S#, T#, L#).
- `docs/adr/` — decisiones de arquitectura.

## Reglas del repo

- `scope/` y `work/` nunca se commitean (ver `.gitignore`).
- Cero dependencias de runtime en `bounty-core`.
- Nada de payloads ni exploits: esto es control, no ataque.
