import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Article, type Session } from '../lib/api';
import { Progress } from '../components/ui';

export default function Grid() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [filter, setFilter] = useState<'todos' | 'pendientes' | 'completados'>('todos');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getSession(sessionId)
      .then(({ session, articles }) => {
        setSession(session);
        setArticles(articles);
      })
      .catch((e) => setError(e.message));
  }, [sessionId]);

  if (error) return <div className="p-10 text-center text-red-600">{error}</div>;
  if (!session) return <div className="p-10 text-center text-slate-400">Cargando…</div>;

  const visible = articles.filter((a) =>
    filter === 'todos' ? true : filter === 'pendientes' ? !a.completed : a.completed
  );

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="truncate font-medium">{session.name}</h1>
          <div className="flex shrink-0 gap-3 text-sm text-slate-500">
            <Link to={`/session/${sessionId}/agrupar`} className="underline">Agrupar</Link>
            <Link to={`/session/${sessionId}`} className="underline">Captura</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          {session.completed} de {session.total} artículos completados · {session.pending} pendientes
        </p>
        <div className="mt-2"><Progress percent={session.percent} /></div>
      </header>

      <div className="mb-4 flex gap-2">
        {(['todos', 'pendientes', 'completados'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-1.5 text-sm capitalize transition-colors ${
              filter === f ? 'bg-slate-900 text-white' : 'border border-slate-300 bg-white text-slate-600'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 pb-8 sm:grid-cols-3 md:grid-cols-4">
        {visible.map((a) => (
          <button
            key={a.id}
            onClick={() => navigate(`/session/${sessionId}?a=${a.id}`)}
            className={`overflow-hidden rounded-xl border-2 bg-white text-left transition-colors ${
              a.completed ? 'border-emerald-400' : 'border-amber-300'
            }`}
          >
            <div className="relative">
              <img
                src={a.coverThumbUrl || a.coverUrl}
                alt=""
                loading="lazy"
                className="h-36 w-full object-cover"
              />
              {a.photos.length > 1 && (
                <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white">
                  {a.photos.length} fotos
                </span>
              )}
            </div>
            <div className="p-2">
              <p className="text-xs text-slate-400">Artículo {a.order + 1}</p>
              {a.completed ? (
                <p className="mt-1 text-xs text-emerald-700">
                  {a.variants.length} {a.variants.length === 1 ? 'talla' : 'tallas'} ·{' '}
                  {a.variants.reduce((sum, v) => sum + (v.stock ?? 0), 0)} pzas
                </p>
              ) : (
                <p className="mt-1 text-xs text-amber-600">Pendiente</p>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
