import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { db, DATA_DIR, UPLOAD_DIR, THUMB_DIR } from './db.js';

// Miniatura cuadrada: alimenta la vista de grid y la imagen embebida en el Excel.
const THUMB_PX = 200;

async function makeThumb(filename) {
  const name = `${path.parse(filename).name}.jpg`;
  await sharp(path.join(UPLOAD_DIR, filename))
    .rotate()
    .resize(THUMB_PX, THUMB_PX, { fit: 'contain', background: '#ffffff' })
    .jpeg({ quality: 78 })
    .toFile(path.join(THUMB_DIR, name));
  return `/uploads/thumbs/${name}`;
}

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

const app = express();
app.use(express.json());

/* ---------- admin ---------- */
function requireAdmin(req, res, next) {
  const pin = req.get('x-admin-pin') || req.query.pin;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrecto' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body?.pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrecto' });
  res.json({ ok: true });
});

/* ---------- uploads ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${nanoid(12)}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 500 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

/* ---------- helpers ---------- */
const stats = db.prepare(`
  SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS completed
  FROM products WHERE sessionId = ?
`);

function withStats(session) {
  const { total, completed } = stats.get(session.id);
  return {
    ...session,
    total,
    completed,
    pending: total - completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
}

const insertProduct = () => db.prepare(`
  INSERT INTO products (id, sessionId, imageUrl, thumbUrl, originalFilename, barcode, stock, completed, "order", createdAt, updatedAt)
  VALUES (@id, @sessionId, @imageUrl, @thumbUrl, @originalFilename, '', NULL, 0, @order, @now, @now)
`);

const sortFiles = (files) =>
  (files || []).sort((a, b) => a.originalname.localeCompare(b.originalname, 'es', { numeric: true }));

// Genera las miniaturas antes de insertar; si alguna falla, el producto igual se guarda.
async function prepareFiles(files) {
  return Promise.all(
    files.map(async (f) => {
      let thumbUrl = '';
      try {
        thumbUrl = await makeThumb(f.filename);
      } catch (err) {
        console.error('No se pudo generar la miniatura de', f.originalname, err.message);
      }
      return { file: f, thumbUrl };
    })
  );
}

/* ---------- sessions ---------- */
app.get('/api/sessions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY createdAt DESC').all();
  res.json(rows.map(withStats));
});

app.post('/api/sessions', requireAdmin, upload.array('photos'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre de la sesión' });

  const id = nanoid(10);
  const now = new Date().toISOString();
  const stmt = insertProduct();
  const prepared = await prepareFiles(sortFiles(req.files));

  db.transaction(() => {
    db.prepare('INSERT INTO sessions (id, name, createdAt) VALUES (?, ?, ?)').run(id, name, now);
    prepared.forEach(({ file, thumbUrl }, i) => {
      stmt.run({
        id: nanoid(12),
        sessionId: id,
        imageUrl: `/uploads/${file.filename}`,
        thumbUrl,
        originalFilename: file.originalname,
        order: i,
        now,
      });
    });
  })();

  res.json(withStats(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)));
});

// Agregar más fotos a una sesión existente
app.post('/api/sessions/:id/photos', requireAdmin, upload.array('photos'), async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  const now = new Date().toISOString();
  const start = db
    .prepare('SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM products WHERE sessionId = ?')
    .get(session.id).next;
  const stmt = insertProduct();
  const prepared = await prepareFiles(sortFiles(req.files));

  db.transaction(() => {
    prepared.forEach(({ file, thumbUrl }, i) => {
      stmt.run({
        id: nanoid(12),
        sessionId: session.id,
        imageUrl: `/uploads/${file.filename}`,
        thumbUrl,
        originalFilename: file.originalname,
        order: start + i,
        now,
      });
    });
  })();

  res.json(withStats(session));
});

// Público: sesión + productos (lo usa el capturista)
app.get('/api/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  const products = db.prepare('SELECT * FROM products WHERE sessionId = ? ORDER BY "order"').all(session.id);
  res.json({
    session: withStats(session),
    products: products.map((p) => ({ ...p, completed: !!p.completed })),
  });
});

app.delete('/api/sessions/:id', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT imageUrl, thumbUrl FROM products WHERE sessionId = ?').all(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM products WHERE sessionId = ?').run(req.params.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  })();
  for (const p of products) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(p.imageUrl)), { force: true }, () => {});
    if (p.thumbUrl) fs.rm(path.join(THUMB_DIR, path.basename(p.thumbUrl)), { force: true }, () => {});
  }
  res.json({ ok: true });
});

/* ---------- captura ---------- */
app.patch('/api/products/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

  // El código de barras SIEMPRE se guarda como string (conserva ceros iniciales).
  const barcode = String(req.body.barcode ?? product.barcode).trim();
  const rawStock = req.body.stock;
  const stock =
    rawStock === '' || rawStock === null || rawStock === undefined ? null : Number.parseInt(rawStock, 10);
  if (stock !== null && Number.isNaN(stock)) return res.status(400).json({ error: 'Stock inválido' });

  const completed = barcode !== '' && stock !== null ? 1 : 0;
  db.prepare('UPDATE products SET barcode = ?, stock = ?, completed = ?, updatedAt = ? WHERE id = ?').run(
    barcode,
    stock,
    completed,
    new Date().toISOString(),
    product.id
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
  res.json({
    product: { ...updated, completed: !!updated.completed },
    stats: withStats(db.prepare('SELECT * FROM sessions WHERE id = ?').get(product.sessionId)),
  });
});

/* ---------- excel ---------- */
app.get('/api/sessions/:id/export.xlsx', requireAdmin, async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  const products = db.prepare('SELECT * FROM products WHERE sessionId = ? ORDER BY "order"').all(session.id);

  const IMG_PX = 90; // lado de la miniatura dentro de la celda

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Productos');
  ws.columns = [
    { header: 'Imagen', key: 'imagen', width: 14 },
    { header: 'Código de barras', key: 'barcode', width: 26 },
    { header: 'Stock', key: 'stock', width: 10 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Archivo', key: 'archivo', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const p of products) {
    const row = ws.addRow({
      imagen: '',
      barcode: p.barcode || '',
      stock: p.stock ?? '',
      estado: p.completed ? 'Completado' : 'Pendiente',
      archivo: p.originalFilename,
    });
    row.height = IMG_PX * 0.75; // px → puntos
    row.alignment = { vertical: 'middle' };

    // Formato texto explícito: evita notación científica y pérdida de ceros iniciales.
    row.getCell('barcode').numFmt = '@';
    row.getCell('barcode').alignment = { horizontal: 'left', vertical: 'middle' };

    // Miniatura embebida en la celda de la columna Imagen.
    const thumb = p.thumbUrl && path.join(THUMB_DIR, path.basename(p.thumbUrl));
    if (thumb && fs.existsSync(thumb)) {
      const imageId = wb.addImage({ filename: thumb, extension: 'jpeg' });
      ws.addImage(imageId, {
        tl: { col: 0.1, row: row.number - 1 + 0.05 },
        ext: { width: IMG_PX, height: IMG_PX },
        editAs: 'oneCell',
      });
    }
  }
  ws.getColumn('barcode').numFmt = '@';

  const safeName = session.name.replace(/[^\wÁÉÍÓÚÑáéíóúñ \-]/g, '').trim() || 'sesion';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(safeName + '.xlsx')}`
  );
  await wb.xlsx.write(res);
  res.end();
});

/* ---------- frontend (producción) ---------- */
const dist = path.join(process.cwd(), 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Error interno' });
});

// Al arrancar, genera las miniaturas que falten (sesiones creadas antes de esta función).
async function backfillThumbs() {
  const pending = db.prepare("SELECT id, imageUrl FROM products WHERE thumbUrl = ''").all();
  if (!pending.length) return;
  console.log(`Generando ${pending.length} miniaturas faltantes…`);
  const update = db.prepare('UPDATE products SET thumbUrl = ? WHERE id = ?');
  for (const p of pending) {
    try {
      update.run(await makeThumb(path.basename(p.imageUrl)), p.id);
    } catch (err) {
      console.error('Miniatura fallida para', p.imageUrl, err.message);
    }
  }
  console.log('Miniaturas listas.');
}

app.listen(PORT, () => {
  console.log(`Photo Linker en http://localhost:${PORT} (datos: ${DATA_DIR})`);
  backfillThumbs();
});
