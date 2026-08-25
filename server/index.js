import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { db, DATA_DIR, UPLOAD_DIR, THUMB_DIR } from './db.js';

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const THUMB_PX = 200; // miniatura: alimenta el grid y la imagen embebida en el Excel

const app = express();
app.use(express.json({ limit: '2mb' }));

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
  limits: { fileSize: 25 * 1024 * 1024, files: 1000 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

async function makeThumb(filename) {
  const name = `${path.parse(filename).name}.jpg`;
  await sharp(path.join(UPLOAD_DIR, filename))
    .rotate()
    .resize(THUMB_PX, THUMB_PX, { fit: 'contain', background: '#ffffff' })
    .jpeg({ quality: 78 })
    .toFile(path.join(THUMB_DIR, name));
  return `/uploads/thumbs/${name}`;
}

const sortFiles = (files) =>
  (files || []).sort((a, b) => a.originalname.localeCompare(b.originalname, 'es', { numeric: true }));

// Genera las miniaturas antes de insertar; si alguna falla, la foto igual se guarda.
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

/* ---------- consultas ---------- */
const q = {
  session: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  articles: db.prepare('SELECT * FROM articles WHERE sessionId = ? ORDER BY "order"'),
  article: db.prepare('SELECT * FROM articles WHERE id = ?'),
  photosOf: db.prepare('SELECT * FROM photos WHERE articleId = ? ORDER BY "order"'),
  variantsOf: db.prepare('SELECT * FROM variants WHERE articleId = ? ORDER BY "order"'),
  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM articles WHERE sessionId = @id) AS total,
      (SELECT COUNT(*) FROM articles a WHERE a.sessionId = @id AND EXISTS (
         SELECT 1 FROM variants v WHERE v.articleId = a.id AND v.barcode <> '' AND v.stock IS NOT NULL
       )) AS completed
  `),
};

const parseSizes = (raw) =>
  String(raw || '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function withStats(session) {
  const { total, completed } = q.stats.get({ id: session.id });
  return {
    ...session,
    sizes: parseSizes(session.sizeRun),
    total,
    completed,
    pending: total - completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
}

function loadArticle(row) {
  const photos = q.photosOf.all(row.id);
  const variants = q.variantsOf.all(row.id);
  const cover = photos.find((p) => p.isCover) || photos[0] || null;
  return {
    id: row.id,
    order: row.order,
    photos,
    coverId: cover?.id ?? null,
    coverUrl: cover?.imageUrl ?? '',
    coverThumbUrl: cover?.thumbUrl ?? '',
    variants,
    completed: variants.some((v) => v.barcode !== '' && v.stock !== null),
  };
}

/* ---------- agrupación ---------- */
// Los artículos son grupos contiguos de fotos, en el orden en que se dispararon.
function createArticlesFor(sessionId, prepared, groupSize, startOrder, now) {
  const insertArticle = db.prepare(
    'INSERT INTO articles (id, sessionId, "order", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)'
  );
  const insertPhoto = db.prepare(`
    INSERT INTO photos (id, sessionId, articleId, imageUrl, thumbUrl, originalFilename, isCover, "order", createdAt)
    VALUES (@id, @sessionId, @articleId, @imageUrl, @thumbUrl, @originalFilename, @isCover, @order, @now)
  `);

  const perArticle = Math.max(1, groupSize);
  let articleIndex = startOrder;

  for (let i = 0; i < prepared.length; i += perArticle) {
    const chunk = prepared.slice(i, i + perArticle);
    const articleId = nanoid(10);
    insertArticle.run(articleId, sessionId, articleIndex, now, now);
    chunk.forEach(({ file, thumbUrl }, j) => {
      insertPhoto.run({
        id: nanoid(12),
        sessionId,
        articleId,
        imageUrl: `/uploads/${file.filename}`,
        thumbUrl,
        originalFilename: file.originalname,
        isCover: j === 0 ? 1 : 0,
        order: j,
        now,
      });
    });
    articleIndex++;
  }
  return articleIndex;
}

/* ---------- sesiones ---------- */
app.get('/api/sessions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY createdAt DESC').all();
  res.json(rows.map(withStats));
});

app.post('/api/sessions', requireAdmin, upload.array('photos'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre de la sesión' });

  const sizeRun = parseSizes(req.body.sizes).join(',');
  const groupSize = Math.max(1, Number.parseInt(req.body.groupSize, 10) || 1);
  const id = nanoid(10);
  const now = new Date().toISOString();
  const prepared = await prepareFiles(sortFiles(req.files));

  db.transaction(() => {
    db.prepare('INSERT INTO sessions (id, name, sizeRun, groupSize, createdAt) VALUES (?, ?, ?, ?, ?)').run(
      id,
      name,
      sizeRun,
      groupSize,
      now
    );
    createArticlesFor(id, prepared, groupSize, 0, now);
  })();

  res.json(withStats(q.session.get(id)));
});

// Agregar más fotos a una sesión existente (se agrupan igual, al final)
app.post('/api/sessions/:id/photos', requireAdmin, upload.array('photos'), async (req, res) => {
  const session = q.session.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  const now = new Date().toISOString();
  const next = db
    .prepare('SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM articles WHERE sessionId = ?')
    .get(session.id).next;
  const prepared = await prepareFiles(sortFiles(req.files));

  db.transaction(() => createArticlesFor(session.id, prepared, session.groupSize, next, now))();
  res.json(withStats(q.session.get(session.id)));
});

// Público: sesión completa (la usa el capturista)
app.get('/api/sessions/:id', (req, res) => {
  const session = q.session.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json({
    session: withStats(session),
    articles: q.articles.all(session.id).map(loadArticle),
  });
});

app.delete('/api/sessions/:id', requireAdmin, (req, res) => {
  const photos = db.prepare('SELECT imageUrl, thumbUrl FROM photos WHERE sessionId = ?').all(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM variants WHERE articleId IN (SELECT id FROM articles WHERE sessionId = ?)').run(
      req.params.id
    );
    db.prepare('DELETE FROM photos WHERE sessionId = ?').run(req.params.id);
    db.prepare('DELETE FROM articles WHERE sessionId = ?').run(req.params.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  })();
  for (const p of photos) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(p.imageUrl)), { force: true }, () => {});
    if (p.thumbUrl) fs.rm(path.join(THUMB_DIR, path.basename(p.thumbUrl)), { force: true }, () => {});
  }
  res.json({ ok: true });
});

/* ---------- captura de tallas ---------- */
// Reemplaza el juego de tallas del artículo. El código de barras SIEMPRE se guarda como string.
app.put('/api/articles/:id/variants', (req, res) => {
  const article = q.article.get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  const rows = Array.isArray(req.body.variants) ? req.body.variants : [];
  const now = new Date().toISOString();
  const clean = [];

  for (const raw of rows) {
    const size = String(raw.size ?? '').trim();
    const barcode = String(raw.barcode ?? '').trim();
    const stockRaw = raw.stock;
    const stock =
      stockRaw === '' || stockRaw === null || stockRaw === undefined ? null : Number.parseInt(stockRaw, 10);
    if (stock !== null && Number.isNaN(stock)) return res.status(400).json({ error: `Stock inválido en la talla ${size || '?'}` });
    if (!barcode && stock === null) continue; // fila vacía: no se guarda ni se exporta
    clean.push({ size, barcode, stock });
  }

  const insert = db.prepare(
    'INSERT INTO variants (id, articleId, size, barcode, stock, "order", updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    db.prepare('DELETE FROM variants WHERE articleId = ?').run(article.id);
    clean.forEach((v, i) => insert.run(nanoid(12), article.id, v.size, v.barcode, v.stock, i, now));
    db.prepare('UPDATE articles SET updatedAt = ? WHERE id = ?').run(now, article.id);
  })();

  res.json({
    article: loadArticle(q.article.get(article.id)),
    stats: withStats(q.session.get(article.sessionId)),
  });
});

/* ---------- ajustar la agrupación ---------- */
// Separa el artículo a partir de una foto: esa foto y las siguientes forman uno nuevo.
app.post('/api/articles/:id/split', requireAdmin, (req, res) => {
  const article = q.article.get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  const photos = q.photosOf.all(article.id);
  const at = photos.findIndex((p) => p.id === req.body.photoId);
  if (at <= 0) return res.status(400).json({ error: 'No se puede separar en la primera foto del artículo' });

  const now = new Date().toISOString();
  const newId = nanoid(10);

  db.transaction(() => {
    db.prepare('UPDATE articles SET "order" = "order" + 1 WHERE sessionId = ? AND "order" > ?').run(
      article.sessionId,
      article.order
    );
    db.prepare('INSERT INTO articles (id, sessionId, "order", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
      newId,
      article.sessionId,
      article.order + 1,
      now,
      now
    );
    photos.slice(at).forEach((p, i) => {
      db.prepare('UPDATE photos SET articleId = ?, "order" = ?, isCover = ? WHERE id = ?').run(
        newId,
        i,
        i === 0 ? 1 : 0,
        p.id
      );
    });
  })();

  res.json({ ok: true });
});

// Une el artículo con el anterior (fotos y tallas se conservan).
app.post('/api/articles/:id/merge-previous', requireAdmin, (req, res) => {
  const article = q.article.get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  const previous = db
    .prepare('SELECT * FROM articles WHERE sessionId = ? AND "order" < ? ORDER BY "order" DESC LIMIT 1')
    .get(article.sessionId, article.order);
  if (!previous) return res.status(400).json({ error: 'Este es el primer artículo' });

  const now = new Date().toISOString();
  const basePhoto = q.photosOf.all(previous.id).length;
  const baseVariant = q.variantsOf.all(previous.id).length;

  db.transaction(() => {
    q.photosOf.all(article.id).forEach((p, i) => {
      db.prepare('UPDATE photos SET articleId = ?, "order" = ?, isCover = 0 WHERE id = ?').run(
        previous.id,
        basePhoto + i,
        p.id
      );
    });
    q.variantsOf.all(article.id).forEach((v, i) => {
      db.prepare('UPDATE variants SET articleId = ?, "order" = ? WHERE id = ?').run(
        previous.id,
        baseVariant + i,
        v.id
      );
    });
    db.prepare('DELETE FROM articles WHERE id = ?').run(article.id);
    db.prepare('UPDATE articles SET "order" = "order" - 1 WHERE sessionId = ? AND "order" > ?').run(
      article.sessionId,
      article.order
    );
    db.prepare('UPDATE articles SET updatedAt = ? WHERE id = ?').run(now, previous.id);
  })();

  res.json({ ok: true });
});

// Reagrupa toda la sesión de N en N (descarta la agrupación actual, conserva las tallas del primer artículo de cada grupo).
app.post('/api/sessions/:id/regroup', requireAdmin, (req, res) => {
  const session = q.session.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  const groupSize = Math.max(1, Number.parseInt(req.body.groupSize, 10) || 1);

  const photos = db
    .prepare(
      `SELECT p.* FROM photos p JOIN articles a ON a.id = p.articleId
       WHERE p.sessionId = ? ORDER BY a."order", p."order"`
    )
    .all(session.id);
  const now = new Date().toISOString();

  db.transaction(() => {
    const oldArticles = q.articles.all(session.id);
    // Las tallas ya capturadas se heredan al artículo que se quede con su misma foto de portada.
    const variantsByFirstPhoto = new Map();
    for (const a of oldArticles) {
      const first = q.photosOf.all(a.id)[0];
      const variants = q.variantsOf.all(a.id);
      if (first && variants.length) variantsByFirstPhoto.set(first.id, variants);
    }

    // Se crean los artículos nuevos y se mueven fotos y tallas ANTES de borrar los viejos:
    // borrarlos primero arrastraría las tallas por el ON DELETE CASCADE.
    let index = 0;
    for (let i = 0; i < photos.length; i += groupSize) {
      const chunk = photos.slice(i, i + groupSize);
      const articleId = nanoid(10);
      db.prepare('INSERT INTO articles (id, sessionId, "order", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
        articleId,
        session.id,
        index++,
        now,
        now
      );
      chunk.forEach((p, j) => {
        db.prepare('UPDATE photos SET articleId = ?, "order" = ?, isCover = ? WHERE id = ?').run(
          articleId,
          j,
          j === 0 ? 1 : 0,
          p.id
        );
        const inherited = j === 0 ? variantsByFirstPhoto.get(p.id) : null;
        if (inherited) {
          inherited.forEach((v, k) =>
            db.prepare('UPDATE variants SET articleId = ?, "order" = ? WHERE id = ?').run(articleId, k, v.id)
          );
        }
      });
    }

    // Los artículos viejos ya quedaron vacíos; lo que siga colgando de ellos sí se descarta.
    const oldIds = oldArticles.map((a) => a.id);
    if (oldIds.length) {
      const marks = oldIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM variants WHERE articleId IN (${marks})`).run(...oldIds);
      db.prepare(`DELETE FROM articles WHERE id IN (${marks})`).run(...oldIds);
    }
    db.prepare('UPDATE sessions SET groupSize = ? WHERE id = ?').run(groupSize, session.id);
  })();

  res.json(withStats(q.session.get(session.id)));
});

app.post('/api/photos/:id/cover', (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo || !photo.articleId) return res.status(404).json({ error: 'Foto no encontrada' });
  db.transaction(() => {
    db.prepare('UPDATE photos SET isCover = 0 WHERE articleId = ?').run(photo.articleId);
    db.prepare('UPDATE photos SET isCover = 1 WHERE id = ?').run(photo.id);
  })();
  res.json({ article: loadArticle(q.article.get(photo.articleId)) });
});

/* ---------- excel ---------- */
app.get('/api/sessions/:id/export.xlsx', requireAdmin, async (req, res) => {
  const session = q.session.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  const articles = q.articles.all(session.id).map(loadArticle);

  const IMG_PX = 90;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Productos');
  ws.columns = [
    { header: 'Imagen', key: 'imagen', width: 14 },
    { header: 'Artículo', key: 'articulo', width: 10 },
    { header: 'Talla', key: 'talla', width: 10 },
    { header: 'Código de barras', key: 'barcode', width: 26 },
    { header: 'Stock', key: 'stock', width: 10 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Archivo', key: 'archivo', width: 36 },
  ];
  ws.getRow(1).font = { bold: true };

  articles.forEach((article, i) => {
    const cover = article.photos.find((p) => p.id === article.coverId) || article.photos[0];
    // Un artículo sin tallas capturadas sale igual, en una fila vacía, como pendiente.
    const rows = article.variants.length ? article.variants : [{ size: '', barcode: '', stock: null }];
    const firstRowNumber = ws.rowCount + 1;

    rows.forEach((v) => {
      const row = ws.addRow({
        imagen: '',
        articulo: i + 1,
        talla: v.size,
        barcode: v.barcode,
        stock: v.stock ?? '',
        estado: v.barcode && v.stock !== null ? 'Completado' : 'Pendiente',
        archivo: cover?.originalFilename ?? '',
      });
      row.height = IMG_PX * 0.75;
      row.alignment = { vertical: 'middle' };
      // Formato texto explícito: evita notación científica y pérdida de ceros iniciales.
      row.getCell('barcode').numFmt = '@';
      row.getCell('barcode').alignment = { horizontal: 'left', vertical: 'middle' };
    });

    const lastRowNumber = ws.rowCount;
    if (lastRowNumber > firstRowNumber) {
      // Una sola foto por artículo, abarcando sus filas de tallas.
      ws.mergeCells(firstRowNumber, 1, lastRowNumber, 1);
      ws.mergeCells(firstRowNumber, 2, lastRowNumber, 2);
      ws.mergeCells(firstRowNumber, 7, lastRowNumber, 7);
    }

    const thumb = cover?.thumbUrl && path.join(THUMB_DIR, path.basename(cover.thumbUrl));
    if (thumb && fs.existsSync(thumb)) {
      const imageId = wb.addImage({ filename: thumb, extension: 'jpeg' });
      ws.addImage(imageId, {
        tl: { col: 0.1, row: firstRowNumber - 1 + 0.05 },
        ext: { width: IMG_PX, height: IMG_PX },
        editAs: 'oneCell',
      });
    }
  });
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

// Al arrancar, genera las miniaturas que falten (fotos subidas antes de esta función).
async function backfillThumbs() {
  const pending = db.prepare("SELECT id, imageUrl FROM photos WHERE thumbUrl = ''").all();
  if (!pending.length) return;
  console.log(`Generando ${pending.length} miniaturas faltantes…`);
  const update = db.prepare('UPDATE photos SET thumbUrl = ? WHERE id = ?');
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
