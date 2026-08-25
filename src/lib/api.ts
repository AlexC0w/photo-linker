export type Session = {
  id: string;
  name: string;
  createdAt: string;
  total: number;
  completed: number;
  pending: number;
  percent: number;
};

export type Product = {
  id: string;
  sessionId: string;
  imageUrl: string;
  originalFilename: string;
  barcode: string;
  stock: number | null;
  completed: boolean;
  order: number;
};

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

  createSession: (name: string, files: File[], onProgress?: (pct: number) => void) =>
    uploadWithProgress('/api/sessions', { name, files, onProgress }),

  addPhotos: (sessionId: string, files: File[], onProgress?: (pct: number) => void) =>
    uploadWithProgress(`/api/sessions/${sessionId}/photos`, { files, onProgress }),

  deleteSession: (id: string) =>
    handle<{ ok: true }>(fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: adminHeaders() })),

  getSession: (id: string) => handle<{ session: Session; products: Product[] }>(fetch(`/api/sessions/${id}`)),

  saveProduct: (id: string, barcode: string, stock: string) =>
    handle<{ product: Product; stats: Session }>(
      fetch(`/api/products/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode, stock }),
      })
    ),

  exportUrl: (id: string) => `/api/sessions/${id}/export.xlsx?pin=${encodeURIComponent(getPin())}`,
};

// XHR para poder mostrar progreso real al subir 100+ fotos.
function uploadWithProgress(
  url: string,
  opts: { name?: string; files: File[]; onProgress?: (pct: number) => void }
): Promise<Session> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    if (opts.name !== undefined) form.append('name', opts.name);
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
        reject(new Error('Respuesta inválida del servidor'));
      }
    };
    xhr.onerror = () => reject(new Error('Fallo de red al subir las imágenes'));
    xhr.send(form);
  });
}
