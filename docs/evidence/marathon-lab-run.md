# Validación en vivo del motor maratón (S99)

Laboratorio local (`127.0.0.1:8787`), programa `lab-marathon` (`lab: true`), `rate_rps: 4`,
`max_requests_per_host: 40`, presupuesto de la corrida 16 llamadas / 1 h. Sesión real: `pi` + modelo real,
un solo hijo, 59 s.

## Qué hizo el agente, sin intervención

1. `bounty_scope` sobre el alcance ya confirmado (hash `ecfa6ec8…`).
2. **Ráfaga**: `bounty_run` con `burst: 4` sobre `/api/invoices/1` → 4/4 respuestas 200.
3. **Mass assignment**: `bounty_run` con `mass_assignment: true` sobre `PUT /api/profile` (endpoint del lab
   que devuelve el cuerpo que recibió).
4. **Bucle**: seis llamadas a `/api/does-not-exist`.
5. **Pivote**: `/api/invoices/2`.

## Verificación en la cadena (`work/lab-marathon/evidence/log.jsonl`, 22 registros, `verify ok`)

**(a) Ráfagas.** Cuatro `execution` con `burstIndex` 0, 1, 2, 3 y un mismo `burstId` (`f13f4b41…`), cada
una con su `execution-result`. Timestamps: `…24.202`, `…24.227`, `…24.240`, `…24.458`. **Máximo de
ejecuciones en una ventana de 1 s: 4**, igual al `rate_rps` declarado: el ritmo compartido no se desbordó.

**(b) Mass assignment.** La ejecución de `PUT /api/profile` lleva
`massAssignmentKeys: [isAdmin, role, verified, isStaff, permissions, emailVerified]`. El servidor del lab
devolvió `{"received":{"name":"tester","isAdmin":true,"role":"admin","verified":true,"isStaff":true,
"permissions":["all"],"emailVerified":true}}`: las claves llegaron al backend.

**(c) Detector de bucle.** `status.md:21`:

```
- loop-detected: /api/does-not-exist — 5 bloqueos idénticos (http:?:not found). Rama abandonada; pivotá a otra funcionalidad.
```

La sexta llamada fue **rechazada antes de ejecutarse** ("ya hubo 5 bloqueos idénticos"), y el pivote a
`/api/invoices/2` funcionó (200 con la factura de bob). La sesión no se bloqueó.

## Fricciones encontradas y corregidas en el camino

1. **`max_requests_per_host` no estaba en la lista de claves permitidas** de `limits`: el scope no
   parseaba. Agregado a `LIMIT_KEYS` (test de parseo ya existente cubre el resto).
2. **`burst` y `mass_assignment` estaban en el esquema equivocado**: el passthrough estaba en
   `bounty_run` pero las propiedades del esquema habían quedado en otra tool, así que el modelo
   recibía "parámetro inexistente". Movidas a `bounty_run`.
3. **Un 404 sin código de estado era invisible** para el detector: `curl -sS` no imprime el status, así
   que `not found` se contaba como éxito y la rama nunca se abandonaba. Ahora un cuerpo de error
   reconocible (`not found`, `forbidden`, `"error":`, …) cuenta como firma de bloqueo. Test nuevo:
   `tests/marathon.test.ts` ("five identical error bodies with no status code…").

## Estado final

- Cadena intacta (`verify ok`, 22 registros).
- Ningún hallazgo creado: el agente anotó que el eco de `mass_assignment` **no** prueba persistencia y
  no lo registró como hallazgo. Comportamiento correcto.
- Un solo rechazo en toda la corrida (el sexto intento al endpoint inexistente, por bucle).

## Límites de esta validación

- Es el lab: ningún host real, ninguna cuenta real.
- El mass assignment se verificó contra un endpoint que hace *echo*: prueba que las claves viajan y se
  registran, no que un backend real las acepte.
- No se probó una corrida de 8 h ni dos programas en paralelo en esta pasada (eso está cubierto por
  `scripts/concurrency-check.ts` y por los límites ya probados).
