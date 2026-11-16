# SSRF con `bounty_run`

1. **Destino permitido**: el `url=` (o equivalente) apuntando a **un host en alcance** o al laboratorio.
   Un SSRF demostrado hacia dentro del propio programa es hallazgo; hacia infraestructura interna, se
   documenta y no se explota.
2. **Nunca**: apuntar a `169.254.169.254`, a rangos privados del objetivo, ni a servicios de terceros. El
   gate ya lo bloquea (dirección interna) y el clasificador lo pausa como `infra-probing-via-proxy`.
3. **Confirmación**: la respuesta del servidor incluye contenido del destino que elegiste, y podés
   repetirlo.
4. **No** uses SSRF para pivotar: se reporta la capacidad, no se encadena.
