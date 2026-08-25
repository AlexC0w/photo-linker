import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type Product, type Session } from '../lib/api';
import { Badge, Button, Input, Progress } from '../components/ui';

export default function Capture() {
  const { sessionId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const [session, setSession] = useState<Session | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [index, setIndex] = useState(0);
  const [barcode, setBarcode] = useState('');
  const [stock, setStock] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const barcodeRef = useRef<HTMLInputElement>(null);
  const current = products[index];

  // Carga inicial: abre el primer pendiente (o el producto indicado en ?p=).
  useEffect(() => {
    api
      .getSession(sessionId)
      .then(({ session, products }) => {
        setSession(session);
        setProducts(products);
        const wanted = searchParams.get('p');
        const at = wanted ? products.findIndex((p) => p.id === wanted) : -1;
        const firstPending = products.findIndex((p) => !p.completed);
        setIndex(at >= 0 ? at : firstPending >= 0 ? firstPending : 0);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Al cambiar de producto: refleja sus valores y enfoca el código de barras.
  useEffect(() => {
    if (!current) return;
    setBarcode(current.barcode || '');
    setStock(current.stock === null ? '' : String(current.stock));
    setStatus('idle');
    setSearchParams({ p: current.id }, { replace: true });
    if (window.matchMedia('(min-width: 640px)').matches) barcodeRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(products.length - 1, Math.max(0, i + delta))),
    [products.length]
  );

  const nextPending = useCallback(() => {
    setIndex((i) => {
      const after = products.findIndex((p, j) => j > i && !p.completed);
      if (after >= 0) return after;
      const any = products.findIndex((p) => !p.completed);
      return any >= 0 ? any : Math.min(products.length - 1, i + 1);
    });
  }, [products]);

  const save = useCallback(
    async (advance: boolean) => {
      if (!current) return;
      setStatus('saving');
      try {
        const { product, stats } = await api.saveProduct(current.id, barcode, stock);
        setProducts((prev) => prev.map((p) => (p.id === product.id ? product : p)));
        setSession(stats);
        setStatus('saved');
        if (advance) nextPending();
      } catch (e) {
        setError((e as Error).message);
        setStatus('error');
      }
    },
    [current, barcode, stock, nextPending]
  );

  // Atajos: Enter guarda y avanza, flechas navegan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save(true);
      } else if (e.key === 'ArrowLeft' && !(e.target as HTMLElement)?.matches('input')) {
        go(-1);
      } else if (e.key === 'ArrowRight' && !(e.target as HTMLElement)?.matches('input')) {
        go(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, go]);

  if (loading) return <div className="p-10 text-center text-slate-400">Cargando…</div>;
  if (error && !session) return <div className="p-10 text-center text-red-600">{error}</div>;
  if (!session || !current)
    return <div className="p-10 text-center text-slate-500">Esta sesión no tiene fotografías.</div>;

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col p-4">
      <header className="mb-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="truncate font-medium">{session.name}</h1>
          <Link to={`/session/${sessionId}/grid`} className="shrink-0 text-sm text-slate-500 underline">
            Ver todos
          </Link>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
          <span>Producto {index + 1} de {products.length}</span>
          <span>{session.completed} completados · {session.pending} pendientes</span>
        </div>
        <div className="mt-2"><Progress percent={session.percent} /></div>
      </header>

      <div className="relative flex min-h-[38dvh] flex-1 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <img
          key={current.id}
          src={current.imageUrl}
          alt={current.originalFilename}
          className="max-h-[52dvh] w-full object-contain"
        />
        <div className="absolute top-3 right-3"><Badge completed={current.completed} /></div>
      </div>
      <p className="mt-2 truncate text-center text-xs text-slate-400">{current.originalFilename}</p>

      <div className="mt-4 space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium">Código de barras</label>
          <Input
            ref={barcodeRef}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="Ej. 0750123456789"
            className="h-14 font-mono text-lg"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Stock</label>
          <Input
            type="number"
            min={0}
            step={1}
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="0"
            className="h-14 text-lg"
          />
        </div>

        <Button size="lg" className="w-full" onClick={() => save(true)} disabled={status === 'saving'}>
          {status === 'saving' ? 'Guardando…' : 'Guardar y siguiente'}
        </Button>

        <div className="grid grid-cols-3 gap-2">
          <Button variant="secondary" onClick={() => go(-1)} disabled={index === 0}>← Anterior</Button>
          <Button variant="secondary" onClick={nextPending}>Saltar</Button>
          <Button variant="secondary" onClick={() => go(1)} disabled={index === products.length - 1}>
            Siguiente →
          </Button>
        </div>

        <p className="pb-4 text-center text-xs text-slate-400">
          {status === 'saved' && <span className="text-emerald-600">Guardado · </span>}
          {status === 'error' && <span className="text-red-600">{error} · </span>}
          Enter: guardar y siguiente · ← → : navegar
        </p>
      </div>
    </div>
  );
}
