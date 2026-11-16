# LFI con `bounty_run`

1. **Baseline**: el parámetro con un valor válido (si existe) para conocer la respuesta normal.
2. **Travsersal de lectura**: `../../../../etc/passwd` y su forma codificada (`..%2f`). Solo lectura.
3. **Confirmación**: que el contenido sea el archivo esperado y no un error genérico. Dos veces.
4. **Nunca**: escritura de archivos, logs poisoning, wrappers que ejecuten (`php://filter` solo si el
   programa lo autoriza y el efecto es lectura), ni rutas fuera de alcance.

Si el traversal llega a un servicio que reenvía (proxy), eso es `infra-probing-via-proxy`: pausa y pide
confirmación.
