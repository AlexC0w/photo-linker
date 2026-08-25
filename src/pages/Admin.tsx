import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, clearPin, getPin, setPin, type Session } from '../lib/api';
import { Button, Card, Input, Progress } from '../components/ui';

export default function Admin() {
  const [authed, setAuthed] = useState(false);
  const [pin, setPinValue] = useState(getPin());
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const saved = getPin();
    if (!saved) return setChecking(false);
    api
      .login(saved)
      .then(() => setAuthed(true))
      .catch(() => clearPin())
      .finally(() => setChecking(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.login(pin);
      setPin(pin);
      setAuthed(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (checking) return <div className="p-10 text-center text-slate-400">Cargando…</div>;

  if (!authed) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <h1 className="text-lg font-semibold">Administrador</h1>
          <form onSubmit={submit} className="mt-4 space-y-3">
            <Input
              type="password"
              inputMode="numeric"
              autoFocus
              placeholder="PIN"
              value={pin}
              onChange={(e) => setPinValue(e.target.value)}
              className="h-12 text-center text-xl tracking-widest"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" size="lg">
              Entrar
            </Button>
          </form>
        </Card>
      </div>
    );
  }

  return <Dashboard onLogout={() => { clearPin(); setAuthed(false); setPinValue(''); }} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [name, setName] = useState('');
  const [sizes, setSizes] = useState('');
  const [groupSize, setGroupSize] = useState('4');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.listSessions().then(setSessions).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Ponle un nombre a la sesión');
    if (!files.length) return setError('Selecciona al menos una fotografía');
    setProgress(0);
    try {
      await api.createSession(
        { name: name.trim(), sizes, groupSize: Number.parseInt(groupSize, 10) || 1, files },
        setProgress
      );
      setName('');
      setFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  async function remove(s: Session) {
    if (!confirm(`¿Eliminar la sesión "${s.name}" con sus ${s.total} artículos y sus fotos? No se puede deshacer.`)) return;
    await api.deleteSession(s.id);
    load();
  }

  async function copyLink(s: Session) {
    const url = `${location.origin}/session/${s.id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      prompt('Copia el enlace:', url);
    }
    setCopied(s.id);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sesiones de captura</h1>
        <Button variant="ghost" onClick={onLogout}>Salir</Button>
      </header>

      <Card className="mb-8">
        <h2 className="font-medium">Nueva sesión</h2>
        <form onSubmit={create} className="mt-4 space-y-3">
          <Input
            className="h-12"
            placeholder='Nombre, ej. "Botas RML agosto"'
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Corrida de tallas</label>
              <Input
                className="h-12"
                placeholder="25,26,27,28,29,30"
                value={sizes}
                onChange={(e) => setSizes(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Se prellenan en cada artículo. Déjalo vacío si cada modelo trae tallas distintas.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Fotos por artículo</label>
              <Input
                className="h-12"
                type="number"
                min={1}
                value={groupSize}
                onChange={(e) => setGroupSize(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Las fotos se agrupan en ese orden; los cortes se corrigen luego en Agrupar.
              </p>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
            className="block w-full cursor-pointer rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white"
          />
          {files.length > 0 && (
            <p className="text-sm text-slate-500">
              {files.length} fotografías · ~{Math.ceil(files.length / (Number.parseInt(groupSize, 10) || 1))} artículos
            </p>
          )}
          {progress !== null && (
            <div className="space-y-1">
              <Progress percent={progress} />
              <p className="text-sm text-slate-500">Subiendo… {progress}%</p>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" size="lg" disabled={progress !== null} className="w-full sm:w-auto">
            {progress !== null ? 'Subiendo…' : 'Crear sesión'}
          </Button>
        </form>
      </Card>

      <div className="space-y-4">
        {sessions.length === 0 && <p className="text-center text-slate-400">Aún no hay sesiones.</p>}
        {sessions.map((s) => (
          <Card key={s.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-medium">{s.name}</h3>
                <p className="text-sm text-slate-500">
                  {new Date(s.createdAt).toLocaleDateString('es-MX', {
                    day: 'numeric', month: 'long', year: 'numeric',
                  })}
                  {s.sizes.length > 0 && ` · tallas ${s.sizes.join(', ')}`}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold">{s.completed} / {s.total}</p>
                <p className="text-sm text-slate-500">artículos · {s.percent}%</p>
              </div>
            </div>

            <div className="my-4"><Progress percent={s.percent} /></div>

            <div className="flex flex-wrap gap-2">
              <Link to={`/session/${s.id}`}><Button variant="secondary">Abrir captura</Button></Link>
              <Link to={`/session/${s.id}/grid`}><Button variant="secondary">Ver artículos</Button></Link>
              <Link to={`/session/${s.id}/agrupar`}><Button variant="secondary">Agrupar</Button></Link>
              <Button variant="secondary" onClick={() => copyLink(s)}>
                {copied === s.id ? '¡Enlace copiado!' : 'Copiar enlace'}
              </Button>
              <a href={api.exportUrl(s.id)}><Button variant="secondary">Descargar Excel</Button></a>
              <Button variant="danger" onClick={() => remove(s)}>Eliminar</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
