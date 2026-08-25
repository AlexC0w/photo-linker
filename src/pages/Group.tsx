import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Article, type Session } from '../lib/api';
import { Button, Card, Input } from '../components/ui';

/*
  Ajuste de la agrupación automática: los artículos son grupos contiguos de fotos,
  así que basta con separar donde el corte quedó mal o unir dos que eran el mismo modelo.
*/
export default function Group() {
  const { sessionId = '' } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [groupSize, setGroupSize] = useState('4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    api
      .getSession(sessionId)
      .then(({ session, articles }) => {
        setSession(session);
        setArticles(articles);
        setGroupSize(String(session.groupSize || 4));
      })
      .catch((e) => setError(e.message));

  useEffect(() => { load(); }, [sessionId]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function regroup() {
    const n = Number.parseInt(groupSize, 10);
    if (!n || n < 1) return setError('Pon cuántas fotos tomas por artículo');
    if (!confirm(`Se rearmarán todos los artículos de ${n} en ${n}. Las tallas capturadas se conservan en el artículo que herede la misma foto de portada. ¿Continuar?`))
      return;
    run(() => api.regroup(sessionId, n));
  }

  if (error && !session) return <div className="p-10 text-center text-red-600">{error}</div>;
  if (!session) return <div className="p-10 text-center text-slate-400">Cargando…</div>;

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="truncate font-medium">{session.name}</h1>
          <div className="flex shrink-0 gap-3 text-sm text-slate-500">
            <Link to={`/session/${sessionId}/grid`} className="underline">Ver todos</Link>
            <Link to={`/session/${sessionId}`} className="underline">Captura</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          {articles.length} artículos · {articles.reduce((n, a) => n + a.photos.length, 0)} fotos
        </p>
      </header>

      <Card className="mb-6">
        <p className="text-sm font-medium">Reagrupar automáticamente</p>
        <p className="mt-1 text-sm text-slate-500">
          Arma los artículos por orden de disparo, tomando N fotos cada uno.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            type="number"
            min={1}
            value={groupSize}
            onChange={(e) => setGroupSize(e.target.value)}
            className="h-10 w-20 text-center"
          />
          <span className="text-sm text-slate-500">fotos por artículo</span>
          <Button onClick={regroup} disabled={busy}>Reagrupar todo</Button>
        </div>
      </Card>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <div className="space-y-3 pb-8">
        {articles.map((a, i) => (
          <Card key={a.id} className="p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-sm font-medium">
                Artículo {i + 1}
                <span className="ml-2 font-normal text-slate-400">
                  {a.photos.length} {a.photos.length === 1 ? 'foto' : 'fotos'}
                </span>
              </p>
              {i > 0 && (
                <Button variant="ghost" disabled={busy} onClick={() => run(() => api.mergePrevious(a.id))}>
                  ↑ Unir con el anterior
                </Button>
              )}
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1">
              {a.photos.map((p, j) => (
                <div key={p.id} className="shrink-0">
                  <div
                    className={`relative h-24 w-24 overflow-hidden rounded-lg border-2 ${
                      p.id === a.coverId ? 'border-slate-900' : 'border-slate-200'
                    }`}
                  >
                    <img src={p.thumbUrl || p.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                    {p.id === a.coverId && (
                      <span className="absolute inset-x-0 bottom-0 bg-slate-900/80 text-center text-[10px] text-white">
                        portada
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex justify-center gap-2 text-[11px]">
                    {p.id !== a.coverId && (
                      <button
                        disabled={busy}
                        onClick={() => run(() => api.setCover(p.id))}
                        className="text-slate-500 underline"
                      >
                        portada
                      </button>
                    )}
                    {j > 0 && (
                      <button
                        disabled={busy}
                        onClick={() => run(() => api.splitArticle(a.id, p.id))}
                        className="text-slate-500 underline"
                      >
                        separar aquí
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
