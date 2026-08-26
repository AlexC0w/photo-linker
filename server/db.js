import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const THUMB_DIR = path.join(UPLOAD_DIR, 'thumbs');

fs.mkdirSync(THUMB_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/*
  Modelo:
    session  → corrida de tallas + fotos por artículo
    photo    → una fotografía del dump, pertenece a un artículo (grupo contiguo)
    article  → un modelo: varias fotos (una es portada) + UN código de barras + varias tallas
    variant  → una talla del artículo con su stock
*/
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sizeRun TEXT NOT NULL DEFAULT '',
    groupSize INTEGER NOT NULL DEFAULT 1,
    storeId TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    barcode TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    ventlyStatus TEXT NOT NULL DEFAULT 'pendiente',
    ventlyMessage TEXT NOT NULL DEFAULT '',
    ventlyProductId TEXT NOT NULL DEFAULT '',
    ventlySentAt TEXT NOT NULL DEFAULT '',
    productName TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    articleId TEXT REFERENCES articles(id) ON DELETE CASCADE,
    imageUrl TEXT NOT NULL,
    thumbUrl TEXT NOT NULL DEFAULT '',
    originalFilename TEXT NOT NULL,
    isCover INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS variants (
    id TEXT PRIMARY KEY,
    articleId TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    size TEXT NOT NULL DEFAULT '',
    stock INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_articles_session ON articles(sessionId, "order");
  CREATE INDEX IF NOT EXISTS idx_photos_article ON photos(articleId, "order");
  CREATE INDEX IF NOT EXISTS idx_photos_session ON photos(sessionId, "order");
  CREATE INDEX IF NOT EXISTS idx_variants_article ON variants(articleId, "order");
`);

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/* Migración: envío a Vently (tienda destino y estado por artículo). */
if (!columnsOf('sessions').includes('storeId')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN storeId TEXT NOT NULL DEFAULT ''`);
}
for (const [col, def] of [
  ['ventlyStatus', `TEXT NOT NULL DEFAULT 'pendiente'`],
  ['ventlyMessage', `TEXT NOT NULL DEFAULT ''`],
  ['ventlyProductId', `TEXT NOT NULL DEFAULT ''`],
  ['ventlySentAt', `TEXT NOT NULL DEFAULT ''`],
  ['productName', `TEXT NOT NULL DEFAULT ''`],
]) {
  if (!columnsOf('articles').includes(col)) db.exec(`ALTER TABLE articles ADD COLUMN ${col} ${def}`);
}

/* Migración: el código de barras pasó de estar por talla a estar en el artículo. */
if (!columnsOf('articles').includes('barcode')) {
  db.exec(`ALTER TABLE articles ADD COLUMN barcode TEXT NOT NULL DEFAULT ''`);
}
if (columnsOf('variants').includes('barcode')) {
  db.exec(`
    UPDATE articles SET barcode = COALESCE((
      SELECT v.barcode FROM variants v
      WHERE v.articleId = articles.id AND v.barcode <> ''
      ORDER BY v."order" LIMIT 1
    ), '') WHERE barcode = '';
    ALTER TABLE variants DROP COLUMN barcode;
  `);
  console.log('Migrado: el código de barras ahora vive en el artículo.');
}

/* Migración del modelo original (1 foto = 1 producto). */
const hasLegacy = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'")
  .get();

if (hasLegacy) {
  const legacy = db.prepare('SELECT * FROM products ORDER BY sessionId, "order"').all();
  const insertArticle = db.prepare(
    'INSERT INTO articles (id, sessionId, barcode, "order", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertPhoto = db.prepare(`
    INSERT INTO photos (id, sessionId, articleId, imageUrl, thumbUrl, originalFilename, isCover, "order", createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertVariant = db.prepare(
    'INSERT INTO variants (id, articleId, size, stock, "order", updatedAt) VALUES (?, ?, \'\', ?, 0, ?)'
  );

  db.transaction(() => {
    for (const p of legacy) {
      const articleId = `a_${p.id}`;
      insertArticle.run(articleId, p.sessionId, p.barcode || '', p.order, p.createdAt, p.updatedAt);
      insertPhoto.run(p.id, p.sessionId, articleId, p.imageUrl, p.thumbUrl || '', p.originalFilename, p.order, p.createdAt);
      if (p.stock !== null) insertVariant.run(`v_${p.id}`, articleId, p.stock, p.updatedAt);
    }
    db.exec('DROP TABLE products');
  })();
  console.log(`Migrados ${legacy.length} productos al modelo de artículos con tallas.`);
}
