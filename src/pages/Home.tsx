import { Link } from 'react-router-dom';
import { Card } from '../components/ui';

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold">Photo Linker</h1>
        <p className="mt-2 text-sm text-slate-500">
          Captura de código de barras y stock a partir de fotografías de productos.
        </p>
        <p className="mt-6 text-sm text-slate-500">
          Si recibiste un enlace de captura, ábrelo directamente. No necesitas cuenta.
        </p>
      </Card>
      {/* Acceso discreto al administrador */}
      <Link to="/admin" className="mt-6 text-xs text-slate-400 hover:text-slate-600">
        ·
      </Link>
    </div>
  );
}
