/*
  Cliente de la API de Vently.

  Vently es un deploy por tienda: cada una tiene su propia base, su propio MinIO y sus
  propios catálogos (la talla "25" no es el mismo size_id en RML que en DOSX1). Por eso
  todo aquí recibe `store` y nada se cachea entre tiendas.

  SOLO LECTURA: este módulo no escribe nada en Vently. Su único trabajo es resolver un
  código de barras a las tallas del producto, para prellenar la captura. El destino de los
  datos capturados es el Excel.
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

/*
  Búsqueda de solo lectura: código de barras → tallas del producto, con su stock actual.

  El catálogo de tallas de una tienda trae nombres repetidos y basura ('', '.', '1'),
  así que se resuelve **id → nombre**, que sí es único, nunca al revés.
*/
export async function lookupByCode(store, code) {
  const clean = String(code || '').trim();
  if (!clean) throw new Error('Falta el código de barras');

  /*
    Un UPC-A de 12 dígitos escaneado con el celular suele llegar como EAN-13 con un cero
    al frente (y al revés). Se prueban las dos formas antes de darlo por inexistente.
  */
  const intentos = [clean];
  if (/^\d{13}$/.test(clean) && clean.startsWith('0')) intentos.push(clean.slice(1));
  else if (/^\d{12}$/.test(clean)) intentos.push('0' + clean);

  let anchor = null;
  let ultimoError = null;
  for (const intento of intentos) {
    try {
      anchor = await call(store, `/products/variant/${encodeURIComponent(intento)}`);
      break;
    } catch (e) {
      if (e.status !== 404) throw e;
      ultimoError = e;
    }
  }
  if (!anchor) {
    const err = new Error(`El código ${clean} no existe en ${store.name || store.id}`);
    err.status = 404;
    err.cause = ultimoError;
    throw err;
  }

  const product = await call(store, `/products/${anchor.product_id}`);
  const sizes = await getSizes(store);
  const nameOf = new Map(sizes.map((s) => [s.id ?? s.size_id, s.name]));

  const raw = product.variants;
  const variants = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');

  const rows = variants
    .filter((v) => v.color_id === anchor.color_id)
    .map((v) => ({
      size: nameOf.get(v.size_id) || '',
      code: v.code,
      stockActual: Number(v.stock) || 0,
      scanned: v.code === anchor.code,
    }))
    .filter((r) => r.size)
    .sort((a, b) => a.size.localeCompare(b.size, 'es', { numeric: true }));

  return {
    productId: anchor.product_id,
    productName: anchor.product_name || product.name || '',
    colorName: anchor.color_name || '',
    // El código tal como está guardado en la tienda, que puede diferir del escaneado
    // en el cero inicial. Es el que se debe guardar y exportar.
    code: anchor.code,
    sizes: rows,
  };
}
