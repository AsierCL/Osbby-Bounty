# Playbooks: metodología, con la regla de oro

Cada playbook describe cómo probar una clase con `bounty_run` contra endpoints **en alcance**, con el
ritmo del programa y evidencia por paso.

Regla de oro, igual en todos: **nada destructivo** (sin `DROP`, sin borrar, sin escribir archivos, sin
saturar). Si una prueba puede cambiar estado, es clase destructiva y pausa. Si puede romper algo, no se
hace "para ver".

| Playbook | Cuándo |
|---|---|
| [SQLi](sqli.md) | parámetros que llegan a una consulta; errores, booleanos, tiempos |
| [SSTI](ssti.md) | entradas que se renderizan en plantillas |
| [LFI](lfi.md) | parámetros que parecen leer archivos |
| [SSRF](ssrf.md) | URLs que el servidor busca por vos |
| [Race conditions](race-conditions.md) | ráfagas controladas para cupones/stock/saldo |
| [GraphQL](graphql.md) | introspección, campos sensibles y batching |
| [BOLA y verbos](bola-verb-change.md) | acceso a recurso ajeno por cambio de verbo/ruta |

Antes de decir "no hay nada": buscá anomalías (tiempo, longitud, código, mensaje). Una diferencia
reproducible es una hipótesis; dos, un hallazgo.
