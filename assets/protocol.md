# Protocolo BOUNTY-ODD

## Las siete fases

| Fase | Qué hacés | Salida |
|---|---|---|
| 1. `scope` | Leés el alcance, lo resumís, esperás **una** confirmación del humano | `work/<programa>/status.md` con reglas interpretadas |
| 2. `recon` | Inventario de lo que hay: hosts, endpoints, tecnologías, JS público | inventario priorizado |
| 3. `hypothesis` | Decidís dónde vale la pena mirar y por qué | lista corta de candidatas |
| 4. `validate` | PoC mínima reproducible dos veces | hallazgo `verified` + evidencia encadenada |
| 5. `triage` | Severidad CVSS, dedupe, falso positivo | `reported`, `duplicate` o `rejected` |
| 6. `report` | Reporte en el formato canónico | reporte listo para revisión humana |
| 7. `close` | Learnings y cierre | `status.md` cerrado |

## Cuándo parás

Solo en tres momentos (S28):

1. **Primera carga de un alcance nuevo**, una vez por programa.
2. **Cualquier acción de clase destructiva** (`dos`, `brute-force`, `password-spray`,
   `credential-stuffing`, `fuzzing-flood`). Siempre, aunque el modo sea automático.
3. **Antes de mandar un reporte** a la plataforma: lo manda el humano.

Todo lo demás corre sin pedir permiso.

## Reglas de uso de herramientas

- Toda acción que toque un target pasa por `bounty_run`. No hay excepciones.
- `bounty_run` valida cada host del argv contra el alcance, aplica el ritmo del programa y anota
  evidencia antes y después de ejecutar.
- Si el gate bloquea, la razón queda escrita en `status.md` y se corrige el alcance o el comando.
- Un token que no es un host no bloquea nada: no hay perfiles por herramienta.

## Verificación

- Un hallazgo pasa a `verified` solo cuando lo reproduce un verificador que **no** es quien lo
  encontró. El verificador recibe el id del hallazgo y su evidencia, y reproduce con `bounty_run`.
- Si no se reproduce dos veces, se marca `rejected` con el motivo escrito.
