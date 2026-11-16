# Race conditions con ráfagas controladas

1. Elegí un endpoint de **prueba autorizado** que haga algo de un solo uso (cupón, stock, saldo).
2. `bounty_run` con `burst: N` (2 a 12) y la misma petición. Cada request reserva su ritmo.
3. Compará resultados: si el recurso de un solo uso se aplica más de una vez, hay carrera.
4. Repetí con N menor para confirmar (dos reproducciones).
5. Nunca uses ráfagas para saturar: el tope por host y el ritmo del programa mandan, y la clase
   destructiva pausa igual.
