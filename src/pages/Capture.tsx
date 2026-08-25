import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, buildDraft, type Article, type Session, type VariantDraft } from '../lib/api';
import { Badge, Button, Input, Progress } from '../components/ui';

export default function Capture() {
  const { sessionId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const [session, setSession] = useState<Session | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [index, setIndex] = useState(0);
  const [rows, setRows] = useState<VariantDraft[]>([]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<string | null>(null);

  // Inputs de la tabla, para saltar de fila con Enter.
  const inputs = useRef(new Map<string, HTMLInputElement | null>());
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

  // Al cambiar de artículo: prellena la corrida de tallas y enfoca el primer código vacío.
  useEffect(() => {
    if (!current || !session) return;
    const draft = buildDraft(current, session.sizes);
    setRows(draft);
    setStatus('idle');
    setSearchParams({ a: current.id }, { replace: true });
    if (window.matchMedia('(min-width: 640px)').matches) {
      const firstEmpty = draft.findIndex((r) => !r.barcode);
      setTimeout(() => inputs.current.get(`${Math.max(0, firstEmpty)}-barcode`)?.focus(), 0);
    }
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
        const { article, stats } = await api.saveVariants(current.id, rows);
        setArticles((prev) => prev.map((a) => (a.id === article.id ? article : a)));
        setSession(stats);
        setStatus('saved');
        if (advance) nextPending();
      } catch (e) {
        setError((e as Error).message);
        setStatus('error');
      }
    },
    [current, rows, nextPending]
  );

  const updateRow = (i: number, field: keyof VariantDraft, value: string) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [field]: value } : r)));

  const addRow = () => setRows((prev) => [...prev, { size: '', barcode: '', stock: '' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, j) => j !== i));

  // Enter: código → stock → siguiente fila → guardar y siguiente artículo.
  function onFieldKeyDown(e: React.KeyboardEvent<HTMLInputElement>, i: number, field: 'barcode' | 'stock') {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (field === 'barcode') return inputs.current.get(`${i}-stock`)?.focus();
    const next = inputs.current.get(`${i + 1}-barcode`);
    if (next) return next.focus();
    save(true);
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
  const captured = rows.filter((r) => r.barcode && r.stock !== '').length;

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
          className="max-h-[42dvh] w-full cursor-zoom-in object-contain"
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

      <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid grid-cols-[4.5rem_1fr_5rem_2rem] items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs font-medium text-slate-500">
          <span>Talla</span>
          <span>Código de barras</span>
          <span>Stock</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[4.5rem_1fr_5rem_2rem] items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Input
              value={row.size}
              onChange={(e) => updateRow(i, 'size', e.target.value)}
              placeholder="Talla"
              className="h-11 px-2 text-center text-sm"
            />
            <Input
              ref={(el) => { inputs.current.set(`${i}-barcode`, el); }}
              value={row.barcode}
              onChange={(e) => updateRow(i, 'barcode', e.target.value)}
              onKeyDown={(e) => onFieldKeyDown(e, i, 'barcode')}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder="Código de barras"
              className="h-11 px-3 font-mono"
            />
            <Input
              ref={(el) => { inputs.current.set(`${i}-stock`, el); }}
              value={row.stock}
              onChange={(e) => updateRow(i, 'stock', e.target.value)}
              onKeyDown={(e) => onFieldKeyDown(e, i, 'stock')}
              type="number"
              min={0}
              step={1}
              placeholder="0"
              className="h-11 px-2 text-center"
            />
            <button
              onClick={() => removeRow(i)}
              title="Quitar fila"
              className="text-slate-300 hover:text-red-600"
            >
              ×
            </button>
          </div>
        ))}
        <button onClick={addRow} className="w-full py-3 text-sm text-slate-500 hover:bg-slate-50">
          + agregar talla
        </button>
      </div>

      <p className="mt-2 text-center text-xs text-slate-400">
        {captured} de {rows.length} tallas capturadas
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
          Enter: pasa de campo y de fila · en la última fila guarda y avanza · Ctrl+Enter: guardar ya
        </p>
      </div>

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
