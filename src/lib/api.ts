export type Session = {
  id: string;
  name: string;
  sizeRun: string;
  sizes: string[];
  groupSize: number;
  storeId: string;
  storeName: string;
  createdAt: string;
  total: number;
  completed: number;
  pending: number;
  percent: number;
};

export type Photo = {
  id: string;
  articleId: string;
  imageUrl: string;
  thumbUrl: string;
  originalFilename: string;
  isCover: number;
  order: number;
};

export type Variant = {
  id?: string;
  size: string;
  stock: number | null;
};

export type Store = { id: string; name: string };

export type Lookup = {
  productId: number;
  productName: string;
  colorName: string;
  sizes: { size: string; code: string; stockActual: number; scanned: boolean }[];
};

export type Article = {
  id: string;
  order: number;
  barcode: string;
  productName: string;
  photos: Photo[];
  coverId: string | null;
  coverUrl: string;
  coverThumbUrl: string;
  variants: Variant[];
  completed: boolean;
};

// Fila de captura en pantalla (el stock se edita como texto para permitir vacío).
export type VariantDraft = { size: string; stock: string };

const PIN_KEY = 'photolinker.pin';

export const getPin = () => localStorage.getItem(PIN_KEY) || '';
export const setPin = (pin: string) => localStorage.setItem(PIN_KEY, pin);
export const clearPin = () => localStorage.removeItem(PIN_KEY);

async function handle<T>(promise: Promise<Response>): Promise<T> {
  const res = await promise;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const adminHeaders = () => ({ 'x-admin-pin': getPin() });
const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json', ...adminHeaders() },
  body: JSON.stringify(body),
});

export const api = {
  login: (pin: string) =>
    handle<{ ok: true }>(
      fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
    ),

  listSessions: () => handle<Session[]>(fetch('/api/sessions', { headers: adminHeaders() })),

  createSession: (
    opts: { name: string; sizes: string; groupSize: number; storeId: string; files: File[] },
    onProgress?: (pct: number) => void
  ) => uploadWithProgress('/api/sessions', { ...opts, onProgress }),

  listStores: () => handle<Store[]>(fetch('/api/stores', { headers: adminHeaders() })),

  setStore: (sessionId: string, storeId: string) =>
    handle<Session>(fetch(`/api/sessions/${sessionId}`, { method: 'PATCH', ...json({ storeId }) })),

  addPhotos: (sessionId: string, files: File[], onProgress?: (pct: number) => void) =>
    uploadWithProgress(`/api/sessions/${sessionId}/photos`, { files, onProgress }),

  deleteSession: (id: string) =>
    handle<{ ok: true }>(fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: adminHeaders() })),

  getSession: (id: string) => handle<{ session: Session; articles: Article[] }>(fetch(`/api/sessions/${id}`)),

  saveArticle: (articleId: string, barcode: string, productName: string, variants: VariantDraft[]) =>
    handle<{ article: Article; stats: Session }>(
      fetch(`/api/articles/${articleId}/variants`, {
        method: 'PUT',
        ...json({ barcode, productName, variants }),
      })
    ),

  lookup: (sessionId: string, code: string) =>
    handle<Lookup>(fetch(`/api/sessions/${sessionId}/lookup?code=${encodeURIComponent(code)}`)),

  splitArticle: (articleId: string, photoId: string) =>
    handle<{ ok: true }>(fetch(`/api/articles/${articleId}/split`, { method: 'POST', ...json({ photoId }) })),

  mergePrevious: (articleId: string) =>
    handle<{ ok: true }>(fetch(`/api/articles/${articleId}/merge-previous`, { method: 'POST', ...json({}) })),

  regroup: (sessionId: string, groupSize: number) =>
    handle<Session>(fetch(`/api/sessions/${sessionId}/regroup`, { method: 'POST', ...json({ groupSize }) })),

  setCover: (photoId: string) =>
    handle<{ article: Article }>(fetch(`/api/photos/${photoId}/cover`, { method: 'POST', ...json({}) })),

  exportUrl: (id: string) => `/api/sessions/${id}/export.xlsx?pin=${encodeURIComponent(getPin())}`,
};

// XHR para poder mostrar progreso real al subir 100+ fotos.
function uploadWithProgress(
  url: string,
  opts: {
    name?: string;
    sizes?: string;
    groupSize?: number;
    storeId?: string;
    files: File[];
    onProgress?: (pct: number) => void;
  }
): Promise<Session> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    if (opts.name !== undefined) form.append('name', opts.name);
    if (opts.sizes !== undefined) form.append('sizes', opts.sizes);
    if (opts.groupSize !== undefined) form.append('groupSize', String(opts.groupSize));
    if (opts.storeId !== undefined) form.append('storeId', opts.storeId);
    opts.files.forEach((f) => form.append('photos', f));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-admin-pin', getPin());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Error ${xhr.status}`));
      } catch {
        // Sin JSON: casi siempre el proxy (502/504) o el servidor cortado a media subida.
        reject(
          new Error(
            xhr.status === 0
              ? 'Se cortó la conexión durante la subida. Intenta con menos fotos a la vez.'
              : `El servidor respondió ${xhr.status} sin datos. Si es 502, la subida fue demasiado grande de un jalón.`
          )
        );
      }
    };
    xhr.onerror = () => reject(new Error('Fallo de red al subir las imágenes'));
    xhr.send(form);
  });
}

// Combina la corrida de tallas de la sesión con lo ya capturado en el artículo.
export function buildDraft(article: Article, sizes: string[]): VariantDraft[] {
  const captured = article.variants.map((v) => ({
    size: v.size,
    stock: v.stock === null ? '' : String(v.stock),
  }));
  const missing = sizes
    .filter((s) => !captured.some((c) => c.size === s))
    .map((s) => ({ size: s, stock: '' }));

  const rank = (size: string) => {
    const i = sizes.indexOf(size);
    return i === -1 ? sizes.length : i; // tallas fuera de la corrida, al final
  };
  const rows = [...captured, ...missing].sort((a, b) => rank(a.size) - rank(b.size));
  return rows.length ? rows : [{ size: '', stock: '' }];
}
