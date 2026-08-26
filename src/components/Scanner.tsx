import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

/*
  Lector de código de barras con la cámara.

  Dos motores:
    - BarcodeDetector nativo (Android/Chrome, macOS): rápido y sin descargar nada.
      Aquí la cámara la abrimos nosotros y le pasamos el <video> cuadro por cuadro.
    - ZXing (iOS/Safari, Chrome de escritorio en Windows): se carga bajo demanda y
      **abre la cámara él mismo** con decodeFromConstraints. Es importante no abrirla
      antes: cualquier decodeFrom* de ZXing llama a reset(), que apaga el stream y
      limpia el srcObject — justo lo que dejaba la cámara encendida sin detectar nada.

  La cámara solo funciona en HTTPS (o localhost).
*/

type Props = {
  onDetect: (code: string) => void;
  onClose: () => void;
};

// Formatos de tienda: EAN/UPC para producto, Code128/39 e ITF para etiquetas internas.
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

const CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

export default function Scanner({ onDetect, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [motor, setMotor] = useState('iniciando…');
  const [cuadros, setCuadros] = useState(0);
  const [tardando, setTardando] = useState(false);
  const [analizando, setAnalizando] = useState(false);

  /*
    Respaldo: foto con la cámara nativa y decodificación de esa imagen.
    Es más confiable que el video en vivo — el sistema enfoca y da resolución completa —
    y sirve cuando el teléfono no engancha el código en movimiento.
  */
  async function decodificarFoto(file: File) {
    setAnalizando(true);
    setError('');
    const url = URL.createObjectURL(file);
    try {
      const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = await import('@zxing/library');
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
      ]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const result = await new BrowserMultiFormatReader(hints).decodeFromImageUrl(url);
      navigator.vibrate?.(80);
      onDetect(result.getText().trim());
    } catch {
      setError('No se distinguió el código en la foto. Acércate más y que quede derecho.');
    } finally {
      URL.revokeObjectURL(url);
      setAnalizando(false);
    }
  }

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;
    let timer = 0;
    let reader: { reset: () => void } | null = null;

    const exito = (code: string) => {
      if (cancelado || !code) return;
      cancelado = true;
      navigator.vibrate?.(80);
      onDetect(code.trim());
    };

    const avisoLento = window.setTimeout(() => !cancelado && setTardando(true), 12000);

    (async () => {
      if (!window.isSecureContext) {
        setError('La cámara necesita HTTPS. Entra por el dominio, no por IP.');
        setMotor('');
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      const Detector = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;

      /* ---------- 1. BarcodeDetector nativo ---------- */
      if (Detector) {
        let detector: any;
        try {
          const soportados: string[] = (await Detector.getSupportedFormats?.()) ?? [];
          const formats = FORMATS.filter((f) => soportados.includes(f));
          // Sin formatos en común, se deja que el detector use todos los suyos:
          // pasarle una lista vacía lo hace fallar sin decir nada.
          detector = formats.length ? new Detector({ formats }) : new Detector();
        } catch {
          detector = null;
        }

        if (detector) {
          try {
            stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
          } catch {
            setError('No se pudo abrir la cámara. Revisa el permiso del navegador.');
            return;
          }
          if (cancelado) return stream.getTracks().forEach((t) => t.stop());

          video.srcObject = stream;
          video.setAttribute('playsinline', 'true');
          await video.play().catch(() => {});
          setMotor('cámara del sistema');

          let n = 0;
          const tick = async () => {
            if (cancelado) return;
            if (video.readyState >= 2 && video.videoWidth > 0) {
              try {
                const found = await detector.detect(video);
                if (found?.length) return exito(found[0].rawValue);
              } catch {
                /* cuadro ilegible: se sigue intentando */
              }
              if (++n % 5 === 0) setCuadros(n);
            }
            timer = window.setTimeout(tick, 100); // ~10 lecturas por segundo
          };
          tick();
          return;
        }
      }

      /* ---------- 2. ZXing: abre la cámara él mismo ---------- */
      try {
        const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = await import('@zxing/library');
        if (cancelado) return;

        // Limitar los formatos acelera bastante la lectura de códigos 1D.
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.ITF,
        ]);
        hints.set(DecodeHintType.TRY_HARDER, true);

        const zxing = new BrowserMultiFormatReader(hints, 200);
        reader = zxing;
        setMotor('ZXing');

        let n = 0;
        await zxing.decodeFromConstraints(CONSTRAINTS, video, (result, err) => {
          if (cancelado) return;
          if (result) return exito(result.getText());
          if (++n % 5 === 0) setCuadros(n);
          if (err && err.name && err.name !== 'NotFoundException' && err.name !== 'ChecksumException') {
            // NotFound es lo normal en cada cuadro sin código; lo demás sí importa.
            setError(err.message || err.name);
          }
        });
      } catch (e) {
        setError(`No se pudo iniciar el lector: ${(e as Error).message}`);
      }
    })();

    return () => {
      cancelado = true;
      clearTimeout(timer);
      clearTimeout(avisoLento);
      reader?.reset();
      stream?.getTracks().forEach((t) => t.stop());
      const v = videoRef.current;
      if (v?.srcObject) {
        (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        v.srcObject = null;
      }
    };
  }, [onDetect]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-4 text-white">
        <span className="text-sm">
          Escanear código <span className="text-white/50">· {motor}{cuadros ? ` · ${cuadros} cuadros` : ''}</span>
        </span>
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} muted playsInline autoPlay className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-28 w-[85%] rounded-xl border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
        </div>
      </div>

      <div className="px-4 pt-3">
        <label className="block">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) decodificarFoto(f);
              e.target.value = '';
            }}
          />
          <span className="block cursor-pointer rounded-xl border border-white/30 py-3 text-center text-white">
            {analizando ? 'Analizando foto…' : 'No lo toma: tomar foto del código'}
          </span>
        </label>
      </div>

      <p className="p-4 text-center text-sm text-white/70">
        {error ? (
          <span className="text-amber-300">{error}</span>
        ) : tardando ? (
          'Acerca el código hasta llenar el marco, con buena luz y sin inclinarlo. Si no lo toma, escríbelo a mano.'
        ) : (
          'Apunta al código de barras. Se cierra solo al leerlo.'
        )}
      </p>
    </div>
  );
}
