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
- **Config local:** `.env` opcional, cargado con `node --env-file-if-exists` (no requiere dotenv).

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

## Lector de código de barras (cámara)

Junto al campo del código hay un botón chico con el icono de código de barras que abre la cámara.
Funciona en Android y en iPhone:

- **Android/Chrome** usa el `BarcodeDetector` nativo del sistema: rápido y sin descargar nada.
- **iOS/Safari** no lo tiene, así que ahí se carga **ZXing** bajo demanda (chunk aparte de ~100 KB
  gzip, solo para quien abre el lector).

Lee EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39 e ITF. Al leer, vibra, cierra la cámara, busca
las tallas y deja el cursor en el primer stock. La barra de arriba muestra qué motor está activo y
cuántos cuadros lleva analizados, para saber si el lector está trabajando o atorado.

Cada cuadro se analiza de tres formas alternadas —la banda del marco, esa banda girada 90° y el
cuadro completo—, con ZXing también invertido. **Nunca se reduce la imagen**: medido con códigos
sintéticos del 5% al 20% del ancho del encuadre, a resolución nativa se leen todos, y reescalados
hacia abajo (a 1024 px) fallan todos. Esa reducción era justo lo que impedía leer.

Si el video en vivo no engancha, el botón **tomar foto del código** usa la cámara nativa del
teléfono (con su enfoque y resolución completa) y decodifica esa imagen. Hay además botón de
**linterna** cuando el equipo la expone.

Ojo con ZXing: cualquiera de sus `decodeFrom*` llama a `reset()`, que apaga el stream y limpia el
`srcObject`. Por eso ZXing abre la cámara él mismo con `decodeFromConstraints` y no se le pasa un
video que ya tenga stream — hacerlo dejaba la cámara encendida sin detectar nada.

**Requiere HTTPS.** La cámara no abre por IP ni por http — en el celular hay que entrar por el
dominio con certificado. En `localhost` sí funciona para probar.

Detalle: un UPC-A de 12 dígitos escaneado suele llegar como EAN-13 con un cero al frente. La
búsqueda prueba ambas formas y guarda **el código tal como está en la tienda**, no el escaneado.

## Buscar tallas por código de barras (solo lectura)

Si la sesión está ligada a una tienda, la búsqueda se dispara sola: al escanear, al dar **Enter** o
al salir del campo del código. Trae del sistema **las tallas reales de ese producto en ese color**, junto con el stock que Vently tiene hoy como referencia en la columna *Sistema*. El
capturista solo teclea cantidades.

Es una consulta de **solo lectura** (`GET /products/variant/:code`, `GET /products/:id`, `GET /sizes`):
no escribe nada en Vently. Basta un usuario con permiso `inventory.view`. Si el código no existe o
la tienda no responde, la tabla se queda editable a mano y la captura sigue — la búsqueda ayuda,
nunca bloquea.

El nombre del producto encontrado se guarda y sale en el Excel, en la columna **Producto**.

Detalle importante: el catálogo de tallas de una tienda trae nombres repetidos y basura (`''`, `'.'`,
`'1'`), así que la resolución es siempre **id → nombre**, nunca al revés.

El endpoint de búsqueda va **sin PIN**, porque lo usa el capturista: quien tenga el enlace de la
sesión puede consultar códigos de esa tienda. Las credenciales nunca salen del servidor.

La app **solo lee** de Vently. No escribe nada: no crea productos, no mueve stock, no sube fotos.
El destino de lo capturado es el Excel.

La tienda se elige al crear la sesión y también se puede **cambiar después**, desde la tarjeta de la
sesión en `/admin` — útil para una sesión que ya venías capturando a mano.

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

### Subidas grandes

Las fotos se suben **en tandas** (múltiplos de las fotos por artículo, ~20 por request) en vez de un
solo envío gigante: 280 fotos de celular pasan de 1 GB y el proxy corta la conexión con un 502 mucho
antes de terminar. Las miniaturas se generan de 4 en 4 y `sharp` va con caché apagado y un solo hilo,
porque lanzarlas todas juntas tumbaba el proceso en un contenedor con poca RAM — ese era el
"Respuesta inválida del servidor".

Probado con 280 fotos: 70 artículos, sin errores y con el proceso por debajo de 100 MB.

El límite por imagen sigue siendo 25 MB. Si aun así ves 502, revisa la memoria asignada al
contenedor en Dokploy.
