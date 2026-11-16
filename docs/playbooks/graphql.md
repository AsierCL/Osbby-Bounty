# GraphQL: introspección y batching

1. **Introspección**: `{"query":"{__schema{types{name kind}}}"}`. Si responde, el esquema es el mapa:
   anotá tipos y campos en `recon-intelligence`.
2. **Campos sensibles**: buscá en el esquema `playerId`, `email`, `token`, `admin`, `role`, y probá
   consultarlos con datos reales del recurso propio.
3. **Batching**: un array de operaciones en un solo POST (`[{...},{...}]`) o aliases en una consulta
   (`a: search... b: search...`). Sirve para probar muchas variantes con una sola petición HTTP; **no**
   para evadir el ritmo.
4. **Mutaciones**: cada `mutation` pausa (clase `graphql-mutation`). Si además toca infraestructura
   interna o rutas no documentadas, pausa como `infra-probing-via-proxy`.
