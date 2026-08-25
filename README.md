# Photo Linker

Herramienta interna para capturar **código de barras** y **stock** a partir de fotografías de productos.

Una persona sube todas las fotos de golpe desde el panel de administrador; la app las agrupa en
artículos (varias fotos del mismo modelo, una es la portada) y otra persona, desde cualquier
dispositivo, abre un enlace público y captura **una fila por talla**: talla, código de barras y stock.

## Modelo

```
session  ─ corrida de tallas + fotos por artículo
  └ article  ─ grupo contiguo de fotos, una es la portada
      ├ photo   ─ archivo original + miniatura
      └ variant ─ talla + código de barras (string) + stock
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
5. El empleado abre el enlace: ve la portada grande (con las demás fotos como miniaturas) y una
   tabla con la corrida de tallas ya prellenada. Solo escribe código y stock.
   - `Enter` salta de código a stock, de fila a fila, y en la última fila guarda y pasa al siguiente
     artículo · `Ctrl+Enter` guarda de inmediato · `←` `→` navegan · **Saltar** lo deja pendiente.
   - Las filas que deje vacías no se guardan ni se exportan.
   - Cada guardado va directo a la base de datos: puede cerrar el navegador y continuar donde iba.
6. Cuando termine, en `/admin` presiona **Descargar Excel**.

Un artículo cuenta como completado cuando tiene al menos una talla con código y stock.

El Excel lleva **una fila por talla** e incluye pendientes y completados, con columnas
`Imagen | Artículo | Talla | Código de barras | Stock | Estado | Archivo`. La foto de portada va
embebida (miniatura de 200 px generada al subir con `sharp`) y su celda se combina a lo alto de las
tallas del artículo. Un artículo sin capturar sale igual, en una fila vacía marcada como pendiente.
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
| `PUT`    | `/api/articles/:id/variants`         | no    | Reemplaza las tallas del artículo.    |
| `POST`   | `/api/articles/:id/split`            | sí    | Separa el artículo a partir de una foto.|
| `POST`   | `/api/articles/:id/merge-previous`   | sí    | Une el artículo con el anterior.      |
| `POST`   | `/api/sessions/:id/regroup`          | sí    | Reagrupa toda la sesión de N en N.    |
| `POST`   | `/api/photos/:id/cover`              | no    | Marca esa foto como portada.          |
| `GET`    | `/api/sessions/:id/export.xlsx`      | sí    | Excel de la sesión.                   |

El PIN va en el header `x-admin-pin` (o `?pin=` para la descarga del Excel).

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
