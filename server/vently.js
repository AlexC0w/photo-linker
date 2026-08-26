import fs from 'node:fs/promises';
import path from 'node:path';

/*
  Cliente de la API de Vently.

  Vently es un deploy por tienda: cada una tiene su propia base, su propio MinIO y sus
  propios catálogos (la talla "25" no es el mismo size_id en RML que en DOSX1). Por eso
  todo aquí recibe `store` y nada se cachea entre tiendas.

  Los productos YA existen en Vently. El linker solo:
    1. resuelve el código de barras → variante → producto,
    2. sube las fotos del artículo a ese producto (por color),
    3. registra el stock de cada talla (entrada o stock final).
*/

const TOKEN_MARGIN_MS = 60 * 1000;
const SIZES_TTL_MS = 5 * 60 * 1000;

const tokens = new Map(); // storeId → { token, expiresAt }
const sizesCache = new Map(); // storeId → { at, list }

export function getStores() {
  const raw = process.env.VENTLY_STORES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : []).filter((s) => s.id && s.url && s.user && s.pass);
  } catch {
    console.error('VENTLY_STORES no es un JSON válido; la integración con Vently queda apagada.');
    return [];
  }
}

// Lo que sí puede ver el navegador: nunca las credenciales.
export const publicStores = () => getStores().map((s) => ({ id: s.id, name: s.name || s.id }));

export const findStore = (id) => getStores().find((s) => s.id === id) || null;

async function login(store) {
  const cached = tokens.get(store.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const res = await fetch(join(store.url, '/auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: store.user, password: store.pass }),
  });
  if (!res.ok) throw new Error(`No se pudo entrar a ${store.name || store.id} (${res.status})`);

  const { token } = await res.json();
  if (!token) throw new Error(`${store.name || store.id} no devolvió token`);

  // El token de Vently dura mucho; se refresca solo cuando caduca o si lo rechazan.
  tokens.set(store.id, { token, expiresAt: Date.now() + 12 * 60 * 60 * 1000 - TOKEN_MARGIN_MS });
  return token;
}

const join = (base, p) => `${String(base).replace(/\/+$/, '')}${p}`;

async function call(store, p, { method = 'GET', json, form, retry = true } = {}) {
  const token = await login(store);
  const res = await fetch(join(store.url, p), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : form,
  });

  // Token vencido o revocado: se pide uno nuevo y se reintenta una sola vez.
  if (res.status === 401 && retry) {
    tokens.delete(store.id);
    return call(store, p, { method, json, form, retry: false });
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body?.error || body?.message || `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function getSizes(store) {
  const cached = sizesCache.get(store.id);
  if (cached && Date.now() - cached.at < SIZES_TTL_MS) return cached.list;
  const body = await call(store, '/sizes');
  const list = body?.data || [];
  sizesCache.set(store.id, { at: Date.now(), list });
  return list;
}

const normalize = (s) => String(s ?? '').trim().toLowerCase();

/* Reconstruye el JSON que `PATCH /products/:id` espera (valida el producto completo). */
function productPayload(product, variantOverrides = new Map()) {
  return {
    name: product.name,
    description: product.description ?? '',
    is_active: !!product.is_active,
    brand_id: product.brand_id,
    category_id: product.category_id ?? null,
    target_audience: product.target_audience || 'unisex',
    variants: (product.variants || []).map((v) => ({
      variant_id: v.variant_id,
      color_id: v.color_id,
      size_id: v.size_id,
      code: v.code,
      stock: variantOverrides.has(v.variant_id) ? variantOverrides.get(v.variant_id) : Number(v.stock),
      cost: Number(v.cost),
      price: Number(v.price),
    })),
  };
}

/*
  Envía un artículo a una tienda.
    article: { barcode, photos:[{imageUrl, originalFilename}], variants:[{size, stock}] }
    mode:    'entry'    → suma el stock capturado como entrada de mercancía
             'absolute' → fija el stock capturado como stock final
  Devuelve { productId, notes: [] } o lanza Error si el artículo no se pudo ligar.
*/
export async function pushArticle(store, article, { mode, sessionName, uploadDir }) {
  const code = String(article.barcode || '').trim();
  if (!code) throw new Error('El artículo no tiene código de barras');

  const notes = [];

  // 1. código → variante ancla → producto
  const anchor = await call(store, `/products/variant/${encodeURIComponent(code)}`).catch((e) => {
    if (e.status === 404) throw new Error(`El código ${code} no existe en ${store.name || store.id}`);
    throw e;
  });
  const productId = anchor.product_id;
  const colorId = anchor.color_id;

  const product = await call(store, `/products/${productId}`);
  const variants = product.variants || [];

  // 2. tallas capturadas → variantes del mismo color
  const sizes = await getSizes(store);
  const matched = [];
  for (const row of article.variants) {
    const size = sizes.find((s) => normalize(s.name) === normalize(row.size));
    if (!size) {
      notes.push(`la talla "${row.size}" no existe en el catálogo de la tienda`);
      continue;
    }
    const variant = variants.find((v) => v.size_id === size.size_id && v.color_id === colorId);
    if (!variant) {
      notes.push(`el producto no tiene la talla ${row.size} en ese color`);
      continue;
    }
    matched.push({ variantId: variant.variant_id, size: row.size, stock: row.stock });
  }
  if (!matched.length) throw new Error(`Ninguna talla capturada existe en el producto (${notes.join('; ')})`);

  // 3. fotos: Vently permite 4 imágenes por color, contando las que ya tiene
  const existing = (variants.find((v) => v.color_id === colorId)?.images || []).length;
  const room = Math.max(0, 4 - existing);
  const toUpload = article.photos.slice(0, room);
  if (!room) notes.push('el producto ya tenía 4 fotos en ese color; no se subió ninguna');
  else if (article.photos.length > room) notes.push(`solo cabían ${room} fotos de ${article.photos.length}`);

  // 4. una sola llamada para fotos y, si aplica, el stock final
  const overrides = new Map();
  if (mode === 'absolute') for (const m of matched) overrides.set(m.variantId, m.stock);

  if (toUpload.length || mode === 'absolute') {
    const form = new FormData();
    form.append('product', JSON.stringify(productPayload(product, overrides)));
    if (product.last_modified) form.append('client_last_modified', String(product.last_modified));
    for (const photo of toUpload) {
      const file = path.join(uploadDir, path.basename(photo.imageUrl));
      const buffer = await fs.readFile(file);
      form.append(`images[${colorId}]`, new Blob([buffer]), photo.originalFilename);
    }
    await call(store, `/products/${productId}`, { method: 'PATCH', form });
  }

  // 5. stock como entrada de mercancía
  if (mode === 'entry') {
    const products = matched.filter((m) => m.stock > 0).map((m) => ({ variant_id: m.variantId, quantity: m.stock }));
    if (products.length) {
      await call(store, '/entries', {
        method: 'POST',
        json: {
          entry_date: new Date().toISOString().slice(0, 10),
          description: `Photo Linker · ${sessionName}`.slice(0, 190),
          products,
        },
      });
    }
    const zeros = matched.filter((m) => m.stock === 0).length;
    if (zeros) notes.push(`${zeros} talla(s) con stock 0 no generan entrada`);
  }

  return { productId, notes };
}
