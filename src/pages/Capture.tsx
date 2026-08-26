import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, buildDraft, type Article, type Session, type VariantDraft } from '../lib/api';
import { Badge, Button, Input, Progress } from '../components/ui';
import { puedeEscanear } from '../lib/camera';

// Solo se descarga el lector (y ZXing) cuando alguien lo abre.
const Scanner = lazy(() => import('../components/Scanner'));

export default function Capture() {
  const { sessionId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const [session, setSession] = useState<Session | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [index, setIndex] = useState(0);
  const [barcode, setBarcode] = useState('');
  const [rows, setRows] = useState<VariantDraft[]>([]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<string | null>(null);
  const [productName, setProductName] = useState('');
  const [reference, setReference] = useState<Record<string, number>>({});
  const [lookupState, setLookupState] = useState<'idle' | 'buscando' | 'ok' | 'sin-resultado'>('idle');
  const [lookupMsg, setLookupMsg] = useState('');
  const [escaneando, setEscaneando] = useState(false);

  const barcodeRef = useRef<HTMLInputElement>(null);
  const stockInputs = useRef(new Map<number, HTMLInputElement | null>());
  const ultimoBuscado = useRef(''); // evita rebuscar lo mismo al salir del campo
  const current = articles[index];

  useEffect(() => {
    api
      .getSession(sessionId)
      .then(({ session, articles }) => {
        setSession(session);
        setArticles(articles);
        const wanted = searchParams.get('a');
        const at = wanted ? articles.findIndex((a) => a.id === wanted) : -1;
        const firstPending = articles.findIndex((a) => !a.completed);
        setIndex(at >= 0 ? at : firstPending >= 0 ? firstPending : 0);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Al cambiar de artículo: prellena la corrida de tallas y enfoca el código de barras.
  useEffect(() => {
    if (!current || !session) return;
    setBarcode(current.barcode || '');
    setRows(buildDraft(current, session.sizes));
    setProductName(current.productName || '');
    setReference({});
    ultimoBuscado.current = '';
    setLookupState('idle');
    setLookupMsg('');
    setStatus('idle');
    setSearchParams({ a: current.id }, { replace: true });
    if (window.matchMedia('(min-width: 640px)').matches) setTimeout(() => barcodeRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, session?.id]);

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(articles.length - 1, Math.max(0, i + delta))),
    [articles.length]
  );

  const nextPending = useCallback(() => {
    setIndex((i) => {
      const after = articles.findIndex((a, j) => j > i && !a.completed);
      if (after >= 0) return after;
      const any = articles.findIndex((a) => !a.completed);
      return any >= 0 ? any : Math.min(articles.length - 1, i + 1);
    });
  }, [articles]);

  const save = useCallback(
    async (advance: boolean) => {
      if (!current) return;
      setStatus('saving');
      try {
        const { article, stats } = await api.saveArticle(current.id, barcode, productName, rows);
        setArticles((prev) => prev.map((a) => (a.id === article.id ? article : a)));
        setSession(stats);
        setStatus('saved');
        if (advance) nextPending();
      } catch (e) {
        setError((e as Error).message);
        setStatus('error');
      }
    },
    [current, barcode, productName, rows, nextPending]
  );

  /*
    Busca el código en la tienda ligada a la sesión y trae las tallas reales del producto.
    Es solo lectura: si falla, la tabla se queda como está y se sigue capturando a mano.
  */
  const lookup = useCallback(
    async (code: string) => {
      const limpio = code.trim();
      if (!session?.storeId || !limpio || limpio === ultimoBuscado.current) return;
      ultimoBuscado.current = limpio;
      setLookupState('buscando');
      setLookupMsg('');
      try {
        const found = await api.lookup(sessionId, code.trim());
        // La tienda manda: si el código guardado trae otro cero inicial, ese es el bueno.
        if (found.code && found.code !== limpio) {
          setBarcode(found.code);
          ultimoBuscado.current = found.code;
        }
        setProductName(found.productName);
        setReference(Object.fromEntries(found.sizes.map((s) => [s.size, s.stockActual])));
        // Nunca se pierde lo ya capturado: las tallas que no vengan de Vently
        // (escritas a mano, o con otro nombre) se conservan al final.
        setRows((prev) => {
          const typed = new Map(prev.filter((r) => r.stock !== '').map((r) => [r.size, r.stock]));
          const fromVently = found.sizes.map((s) => ({ size: s.size, stock: typed.get(s.size) ?? '' }));
          const nombres = new Set(found.sizes.map((s) => s.size));
          const sueltas = prev.filter((r) => r.stock !== '' && !nombres.has(r.size));
          return [...fromVently, ...sueltas];
        });
        setLookupState('ok');
        setLookupMsg(found.colorName ? `${found.productName} · ${found.colorName}` : found.productName);
      } catch (e) {
        ultimoBuscado.current = ''; // que se pueda reintentar el mismo código
        setLookupState('sin-resultado');
        setLookupMsg((e as Error).message);
      }
    },
    [session?.storeId, sessionId]
  );

  const alEscanear = useCallback(
    async (code: string) => {
      setEscaneando(false);
      setBarcode(code);
      if (session?.storeId) await lookup(code);
      setTimeout(() => stockInputs.current.get(0)?.focus(), 0);
    },
    [session?.storeId, lookup]
  );

  const updateRow = (i: number, field: keyof VariantDraft, value: string) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [field]: value } : r)));

  const addRow = () => setRows((prev) => [...prev, { size: '', stock: '' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, j) => j !== i));

  // Enter encadena: código → primer stock → siguiente talla → guardar y siguiente artículo.
  const focusStock = (i: number) => stockInputs.current.get(i)?.focus();

  async function onBarcodeKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (session?.storeId) await lookup(barcode);
    setTimeout(() => focusStock(0), 0);
  }

  function onStockKeyDown(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (i + 1 < rows.length) focusStock(i + 1);
    else save(true);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.matches?.('input');
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save(true);
      } else if (!inField && e.key === 'ArrowLeft') go(-1);
      else if (!inField && e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, go]);

  async function chooseCover(photoId: string) {
    const { article } = await api.setCover(photoId);
    setArticles((prev) => prev.map((a) => (a.id === article.id ? article : a)));
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Cargando…</div>;
  if (error && !session) return <div className="p-10 text-center text-red-600">{error}</div>;
  if (!session || !current)
    return <div className="p-10 text-center text-slate-500">Esta sesión no tiene fotografías.</div>;

  const cover = current.photos.find((p) => p.id === current.coverId) || current.photos[0];
  const piezas = rows.reduce((sum, r) => sum + (Number.parseInt(r.stock, 10) || 0), 0);
  const conStock = rows.filter((r) => r.stock !== '').length;

  return (
    <div className="mx-auto max-w-3xl p-4 pb-28 sm:pb-8">
      <header className="mb-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="truncate font-medium">{session.name}</h1>
          <Link to={`/session/${sessionId}/grid`} className="shrink-0 text-sm text-slate-500 underline">
            Ver todos
          </Link>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
          <span>Artículo {index + 1} de {articles.length}</span>
          <span>{session.completed} completados · {session.pending} pendientes</span>
        </div>
        <div className="mt-2"><Progress percent={session.percent} /></div>
      </header>

      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <img
          key={cover?.id}
          src={cover?.imageUrl}
          alt={cover?.originalFilename}
          onClick={() => cover && setZoom(cover.imageUrl)}
          className="max-h-[38dvh] w-full cursor-zoom-in object-contain"
        />
        <div className="absolute top-3 right-3"><Badge completed={current.completed} /></div>
      </div>

      {current.photos.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {current.photos.map((p) => (
            <button
              key={p.id}
              onClick={() => chooseCover(p.id)}
              onDoubleClick={() => setZoom(p.imageUrl)}
              title="Usar como portada (doble clic para ampliar)"
              className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 ${
                p.id === current.coverId ? 'border-slate-900' : 'border-transparent'
              }`}
            >
              <img src={p.thumbUrl || p.imageUrl} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <label className="text-sm font-medium">Código de barras del artículo</label>
          {session.storeId && (
            <span className="truncate text-xs text-slate-400">
              {lookupState === 'buscando' && 'buscando…'}
              {lookupState === 'ok' && <span className="text-emerald-600">{lookupMsg}</span>}
              {lookupState === 'sin-resultado' && <span className="text-amber-600">{lookupMsg}</span>}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            ref={barcodeRef}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={onBarcodeKeyDown}
            onBlur={() => lookup(barcode)}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="Ej. 0750123456789"
            className="h-14 flex-1 font-mono text-lg"
          />
          {puedeEscanear() && (
            <button
              type="button"
              onClick={() => setEscaneando(true)}
              title="Escanear con la cámara"
              aria-label="Escanear con la cámara"
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            >
              {/* código de barras */}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H6M18 4h1.5A1.5 1.5 0 0 1 21 5.5V7M21 17v1.5a1.5 1.5 0 0 1-1.5 1.5H18M6 20H4.5A1.5 1.5 0 0 1 3 18.5V17" />
                <path d="M7 8v8M10 8v8M13.5 8v8M17 8v8" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid grid-cols-[1fr_4rem_7rem_2rem] items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs font-medium text-slate-500">
          <span>Talla</span>
          <span className="text-center">Sistema</span>
          <span>Stock</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[1fr_4rem_7rem_2rem] items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Input
              value={row.size}
              onChange={(e) => updateRow(i, 'size', e.target.value)}
              placeholder="Talla"
              className="h-12"
            />
            <span className="text-center text-sm text-slate-400">
              {reference[row.size] !== undefined ? reference[row.size] : '·'}
            </span>
            <Input
              ref={(el) => { stockInputs.current.set(i, el); }}
              value={row.stock}
              onChange={(e) => updateRow(i, 'stock', e.target.value)}
              onKeyDown={(e) => onStockKeyDown(e, i)}
              type="number"
              min={0}
              step={1}
              placeholder="—"
              className="h-12 px-2 text-center text-lg"
            />
            <button onClick={() => removeRow(i)} title="Quitar talla" className="text-slate-300 hover:text-red-600">
              ×
            </button>
          </div>
        ))}
        <button onClick={addRow} className="w-full py-3 text-sm text-slate-500 hover:bg-slate-50">
          + agregar talla
        </button>
      </div>

      <p className="mt-2 text-center text-xs text-slate-400">
        {conStock} {conStock === 1 ? 'talla' : 'tallas'} con stock · {piezas} piezas
      </p>

      <div className="fixed inset-x-0 bottom-0 space-y-2 border-t border-slate-200 bg-slate-50 p-3 sm:static sm:mt-4 sm:border-0 sm:bg-transparent sm:p-0">
        <Button size="lg" className="w-full" onClick={() => save(true)} disabled={status === 'saving'}>
          {status === 'saving' ? 'Guardando…' : 'Guardar y siguiente'}
        </Button>
        <div className="grid grid-cols-3 gap-2">
          <Button variant="secondary" onClick={() => go(-1)} disabled={index === 0}>← Anterior</Button>
          <Button variant="secondary" onClick={nextPending}>Saltar</Button>
          <Button variant="secondary" onClick={() => go(1)} disabled={index === articles.length - 1}>
            Siguiente →
          </Button>
        </div>
        <p className="hidden text-center text-xs text-slate-400 sm:block">
          {status === 'saved' && <span className="text-emerald-600">Guardado · </span>}
          {status === 'error' && <span className="text-red-600">{error} · </span>}
          Enter: del código pasa a las tallas y baja fila por fila; en la última guarda y avanza · Ctrl+Enter: guardar ya
        </p>
      </div>

      {escaneando && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black p-6 text-white">Abriendo cámara…</div>}>
          <Scanner onDetect={alEscanear} onClose={() => setEscaneando(false)} />
        </Suspense>
      )}

      {zoom && (
        <div
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
        >
          <img src={zoom} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}
