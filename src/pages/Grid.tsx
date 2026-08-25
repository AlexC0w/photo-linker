import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Product, type Session } from '../lib/api';
import { Progress } from '../components/ui';

export default function Grid() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [filter, setFilter] = useState<'todos' | 'pendientes' | 'completados'>('todos');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getSession(sessionId)
      .then(({ session, products }) => {
        setSession(session);
        setProducts(products);
      })
      .catch((e) => setError(e.message));
  }, [sessionId]);

  if (error) return <div className="p-10 text-center text-red-600">{error}</div>;
  if (!session) return <div className="p-10 text-center text-slate-400">Cargando…</div>;

  const visible = products.filter((p) =>
    filter === 'todos' ? true : filter === 'pendientes' ? !p.completed : p.completed
  );

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="truncate font-medium">{session.name}</h1>
          <Link to={`/session/${sessionId}`} className="shrink-0 text-sm text-slate-500 underline">
            Volver a captura
          </Link>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          {session.completed} de {session.total} completados · {session.pending} pendientes
        </p>
        <div className="mt-2"><Progress percent={session.percent} /></div>
      </header>

      <div className="mb-4 flex gap-2">
        {(['todos', 'pendientes', 'completados'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-1.5 text-sm capitalize transition-colors ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 border border-slate-300'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 pb-8 sm:grid-cols-3 md:grid-cols-4">
        {visible.map((p) => (
          <button
            key={p.id}
            onClick={() => navigate(`/session/${sessionId}?p=${p.id}`)}
            className={`overflow-hidden rounded-xl border-2 bg-white text-left transition-colors ${
              p.completed ? 'border-emerald-400' : 'border-amber-300'
            }`}
          >
            <img src={p.thumbUrl || p.imageUrl} alt={p.originalFilename} loading="lazy" className="h-36 w-full object-cover" />
            <div className="p-2">
              <p className="truncate text-xs text-slate-400">{p.originalFilename}</p>
              {p.completed ? (
                <p className="mt-1 truncate font-mono text-xs">
                  {p.barcode} · <span className="font-sans">stock {p.stock}</span>
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
