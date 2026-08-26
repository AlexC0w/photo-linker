# Photo Linker

Herramienta interna para capturar **código de barras** y **stock** a partir de fotografías de productos.

Una persona sube todas las fotos de golpe desde el panel de administrador; la app las agrupa en
artículos (varias fotos del mismo modelo, una es la portada) y otra persona, desde cualquier
dispositivo, abre un enlace público y captura **un código de barras por artículo** y **el stock de
cada talla**.

## Modelo

```
session  ─ corrida de tallas + fotos por artículo
  └ article  ─ grupo contiguo de fotos (una es portada) + código de barras (string)
      ├ photo   ─ archivo original + miniatura
      └ variant ─ talla + stock
```

Los artículos son **grupos contiguos** de fotos en el orden en que se dispararon: por eso agrupar de
N en N funciona, y corregir un corte es solo separar o unir.

## Stack

- **Frontend:** React 19 + Vite + TypeScript + Tailwind CSS 4 (componentes propios, estilo shadcn).
- **Backend:** Node.js + Express.
- **Base de datos:** SQLite (better-sqlite3) — un solo archivo, cero configuración.
- **Imágenes:** disco del servidor (`DATA_DIR/uploads`), con miniaturas generadas por `sharp`.
- **Excel:** ExcelJS.

Todo vive en un solo proyecto: `npm install && npm run dev`. No hay servicios externos ni costos.

## Ejecutar en local

```bash
npm install
cp .env.example .env    # opcional
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3000 (el dev server hace proxy de `/api` y `/uploads`)

Producción local:

```bash
npm run build
npm start               # sirve API + frontend en http://localhost:3000
```

## Variables de entorno

| Variable    | Default   | Descripción                                              |
| ----------- | --------- | -------------------------------------------------------- |
| `ADMIN_PIN` | `1234`    | PIN del panel `/admin`.                                   |
| `PORT`      | `3000`    | Puerto del servidor.                                      |
| `DATA_DIR`  | `./data`  | Carpeta con `app.db` y `uploads/`. En Docker: `/data`.    |
| `VENTLY_STORES` | vacío | JSON con las tiendas de Vently a las que se puede enviar. |

## Rutas

| Ruta                        | Qué es                                                        |
| --------------------------- | ------------------------------------------------------------- |
| `/`                         | Pantalla inicial (el punto discreto abajo lleva a `/admin`).   |
| `/admin`                    | Panel: crear sesiones, subir fotos, progreso, Excel, eliminar. |
| `/session/:sessionId`       | Captura pública (sin login). Abre el primer producto pendiente.|
| `/session/:sessionId/grid`  | Miniaturas de todos los artículos con su estado.               |
| `/session/:sessionId/agrupar` | Ajustar la agrupación: separar, unir y elegir portada.       |

## Flujo

1. Entra a `/admin` y pon el PIN.
2. Crea una sesión ("Botas RML agosto"), escribe la **corrida de tallas** (`25,26,27,28`), di cuántas
   **fotos por artículo** disparas (ej. 4) y selecciona las 100 fotos de una sola vez.
3. La app arma los artículos por orden de disparo. Si algún corte salió mal, entra a **Agrupar** y
   usa *separar aquí* / *unir con el anterior*, o elige otra portada.
4. Presiona **Copiar enlace** y mándaselo al empleado.
5. El empleado abre el enlace: ve la portada grande (con las demás fotos como miniaturas), captura
   **un solo código de barras** para el artículo y luego el stock de cada talla, con la corrida ya
   prellenada.
   - `Enter` pasa del código a la primera talla y va bajando fila por fila; en la última guarda y
     salta al siguiente artículo · `Ctrl+Enter` guarda de inmediato · `←` `→` navegan ·
     **Saltar** lo deja pendiente.
   - Las tallas que deje sin stock no se guardan ni se exportan; un `0` sí se guarda (agotada).
   - Cada guardado va directo a la base de datos: puede cerrar el navegador y continuar donde iba.
6. Cuando termine, en `/admin` presiona **Descargar Excel**.

Un artículo cuenta como completado cuando tiene código de barras y al menos una talla con stock.

El Excel lleva **una fila por talla** e incluye pendientes y completados, con columnas
`Imagen | Artículo | Código de barras | Talla | Stock | Estado | Archivo`. Lo que es del artículo
—foto, número, código y archivo— se combina en una celda a lo alto de sus tallas. La portada va
embebida (miniatura de 200 px generada al subir con `sharp`). Un artículo sin capturar sale igual,
en una fila vacía marcada como pendiente.
El código de barras se guarda y exporta **siempre como texto**, así que conserva ceros iniciales y
no se convierte a notación científica.

## API

| Método   | Endpoint                             | Admin | Descripción                          |
| -------- | ------------------------------------ | ----- | ------------------------------------- |
| `POST`   | `/api/admin/login`                   | —     | Valida el PIN.                        |
| `GET`    | `/api/sessions`                      | sí    | Lista sesiones con progreso.          |
| `POST`   | `/api/sessions`                      | sí    | Crea sesión (multipart: `name`, `photos[]`). |
| `POST`   | `/api/sessions/:id/photos`           | sí    | Agrega más fotos (se agrupan al final).|
| `GET`    | `/api/sessions/:id`                  | no    | Sesión + artículos (capturista).      |
| `DELETE` | `/api/sessions/:id`                  | sí    | Elimina sesión, fotos y tallas.       |
| `PUT`    | `/api/articles/:id/variants`         | no    | Guarda el código y reemplaza sus tallas.|
| `POST`   | `/api/articles/:id/split`            | sí    | Separa el artículo a partir de una foto.|
| `POST`   | `/api/articles/:id/merge-previous`   | sí    | Une el artículo con el anterior.      |
| `POST`   | `/api/sessions/:id/regroup`          | sí    | Reagrupa toda la sesión de N en N.    |
| `POST`   | `/api/photos/:id/cover`              | no    | Marca esa foto como portada.          |
| `GET`    | `/api/sessions/:id/export.xlsx`      | sí    | Excel de la sesión.                   |

El PIN va en el header `x-admin-pin` (o `?pin=` para la descarga del Excel).

## Enviar a Vently

Vently es **un deploy por tienda**: cada una tiene su propia base, su propio MinIO y sus propios
catálogos (la talla "25" no es el mismo `size_id` en RML que en DOSX1). Por eso las tiendas se
declaran en `VENTLY_STORES` y **cada sesión elige la suya al crearse**:

```
VENTLY_STORES=[{"id":"rml","name":"RML Store","url":"https://api.rml.mx","user":"linker","pass":"..."}]
```

Las credenciales viven solo en el servidor; al navegador solo llegan los nombres.

**Los productos ya existen en Vently.** El linker no crea nada: liga foto y stock a lo que ya está.
Por cada artículo completado hace:

1. `GET /products/variant/{código}` → resuelve la variante ancla, y de ahí `product_id` y `color_id`.
2. `GET /products/{id}` → trae las variantes reales del producto.
3. Casa cada talla capturada contra el catálogo de esa tienda (`GET /sizes`) y contra las variantes
   **del mismo color**. Lo que no exista se reporta como aviso, sin inventar IDs.
4. `PATCH /products/{id}` con las fotos del artículo en `images[color_id]` (Vently admite 4 por
   color, contando las que ya tenga) y `client_last_modified` para no pisar cambios ajenos.
5. El stock, según lo que elijas al enviar:
   - **Mercancía que entra** → `POST /entries`, que suma al stock y deja la entrada registrada.
   - **Conteo** → el mismo `PATCH` fija el stock capturado como stock final.

El botón está en `/admin`, por sesión, y muestra un resumen: enviados, errores y avisos por artículo.
Solo se envían los artículos **completados que no se hayan enviado antes** — reenviar duplicaría
entradas de stock. Si editas un artículo ya enviado, vuelve a quedar por enviar.

## Deploy en Dokploy

1. Sube este repo a Git (rama `main`) con el `package-lock.json` commiteado.
2. En Dokploy crea una **Application** → Build Type **Dockerfile**.
3. **Advanced → Volumes → Volume Mount**, Mount Path `/data` ← paso crítico: ahí viven la base de
   datos y las imágenes. Sin volumen se pierde todo en cada redeploy.
4. **Environment**: `ADMIN_PIN=tu_pin` (el `DATA_DIR=/data` y `PORT=3000` ya vienen en el Dockerfile).
5. Puerto interno `3000`, dominio con HTTPS de Let's Encrypt.
6. Deploy. La base de datos se crea sola en el primer arranque; no hay pasos manuales.

Si vas a subir muchas fotos de golpe, revisa que el proxy (Traefik/Nginx) permita cuerpos grandes;
el límite de la app es 25 MB por imagen y 500 imágenes por subida.
