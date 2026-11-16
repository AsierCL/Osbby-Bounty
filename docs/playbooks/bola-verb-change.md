# BOLA y cambio de verbo

1. Con la sesión inyectada (`work/<programa>/session.headers`), pedí un recurso **ajeno** por GET.
2. Si devuelve 403/401, probá el mismo id con `PUT`, `PATCH`, `DELETE` y `POST` (el control puede estar
   sólo en el handler de lectura).
3. Probá variantes de ruta: `/api/v1/user/` vs `/api/v1/admin/`, versión vieja (`/v0/`), sin prefijo.
4. Cada variante es una petición más en la cadena; si una devuelve datos de otro usuario, es BOLA.
5. `DELETE`/`PUT` que **cambian** estado son clase destructiva: si el gate las marca, la pausa humana
   decide.
