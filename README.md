# Photo Linker

Herramienta interna para capturar **código de barras** y **stock** a partir de fotografías de productos.

Una persona sube las fotos desde el panel de administrador; otra persona, desde cualquier
dispositivo, abre un enlace público y captura los datos foto por foto.

## Stack

- **Frontend:** React 19 + Vite + TypeScript + Tailwind CSS 4 (componentes propios, estilo shadcn).
- **Backend:** Node.js + Express.
- **Base de datos:** SQLite (better-sqlite3) — un solo archivo, cero configuración.
- **Imágenes:** disco del servidor (`DATA_DIR/uploads`), servidas por Express.
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
| `/session/:sessionId/grid`  | Miniaturas de todos los productos con su estado.               |

## Flujo

1. Entra a `/admin` y pon el PIN.
2. Crea una sesión ("Botas RML agosto") y selecciona las 100 fotos de una sola vez.
3. Presiona **Copiar enlace** y mándaselo al empleado.
4. El empleado abre el enlace: ve una foto grande, escribe código de barras + stock y presiona **Enter**.
   - `Enter` = guardar y siguiente · `←` `→` = navegar · **Saltar** = dejarlo pendiente.
   - Cada guardado va directo a la base de datos: puede cerrar el navegador y continuar donde iba.
5. Cuando termine, en `/admin` presiona **Descargar Excel**.

El Excel incluye pendientes y completados, con columnas `Imagen | Código de barras | Stock | Estado`.
El código de barras se guarda y exporta **siempre como texto**, así que conserva ceros iniciales y
no se convierte a notación científica.

## API

| Método   | Endpoint                             | Admin | Descripción                          |
| -------- | ------------------------------------ | ----- | ------------------------------------- |
| `POST`   | `/api/admin/login`                   | —     | Valida el PIN.                        |
| `GET`    | `/api/sessions`                      | sí    | Lista sesiones con progreso.          |
| `POST`   | `/api/sessions`                      | sí    | Crea sesión (multipart: `name`, `photos[]`). |
| `POST`   | `/api/sessions/:id/photos`           | sí    | Agrega más fotos a una sesión.        |
| `GET`    | `/api/sessions/:id`                  | no    | Sesión + productos (capturista).      |
| `DELETE` | `/api/sessions/:id`                  | sí    | Elimina sesión y sus imágenes.        |
| `PATCH`  | `/api/products/:id`                  | no    | Guarda `barcode` (string) y `stock`.  |
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
