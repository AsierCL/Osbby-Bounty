# SSTI con `bounty_run`

1. **Detección aritmética**: `{{7*7}}`, `${7*7}`, `<%= 7*7 %>`, `#{7*7}` en el parámetro, uno por vez.
2. **Control**: el mismo parámetro con `{{7*8}}` y con texto plano. Si `49` aparece en la respuesta y no
   en el control, hay evaluación.
3. **Confirmación no destructiva**: `{{7*'7'}}` (49 o 7777 según motor) para distinguir motor, sin ejecutar
   comandos.
4. **Nunca**: payloads que ejecuten comandos o lean archivos del servidor. Eso es clase destructiva y,
   además, no hace falta para demostrar el hallazgo.

Evidencia: la respuesta con el resultado de la expresión y el control. Clase `ssti`.
