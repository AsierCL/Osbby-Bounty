# SQLi con `bounty_run`

1. **Baseline**: el parámetro con un valor normal, dos veces. Anotá tamaño, tiempo y código.
2. **Comilla**: `'` y `"` sueltos. Buscá error de base de datos, 500 nuevo o cambio de tamaño.
3. **Booleano**: `AND 1=1` vs `AND 1=2` con el mismo tamaño de respuesta esperado. La diferencia de
   *contenido* es la señal; dos reproducciones.
4. **Tiempo**: solo si el booleano no distingue y el programa permite el volumen. Un `SLEEP` pequeño
   (1 s) y su control.
5. **Nunca**: `DROP`, `DELETE`, `UPDATE`, `INSERT`, `UNION` con escritura, ni cargas que toquen datos.

Evidencia: `observation` con la petición, la respuesta y la comparación; el `execution` queda solo en la
cadena. Si hay señal, `bounty_finding` clase `sqli` y después el verificador.
