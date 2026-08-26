import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

/*
  Lector de código de barras con la cámara.

  Dos motores:
    - BarcodeDetector nativo (Android/Chrome, macOS): rápido y sin descargar nada.
    - ZXing (iOS/Safari, Chrome de escritorio): se carga bajo demanda.

  Cada cuadro se mira de tres formas, alternadas: la banda del marco, esa banda girada
  90° (códigos verticales) y el cuadro completo. Y con ZXing, además, invertido (etiqueta
  blanca sobre negro). Lo que nunca se hace es reducir la imagen: medido, un código de
  5% del ancho se lee a resolución nativa y se vuelve ilegible si se reescala hacia abajo.

  La cámara solo funciona en HTTPS (o localhost).
*/

type Props = {
  onDetect: (code: string) => void;
  onClose: () => void;
};

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

const CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

/*
  Recorte: la banda central donde está el marco de la guía.

  Medido con códigos sintéticos de 5% a 20% del ancho del cuadro: a resolución nativa
  el recorte y el cuadro completo leen bien incluso el más chico, pero **reducir** el
  recorte (p. ej. a 1024 px) lo vuelve ilegible siempre. Por eso aquí solo se amplía,
  nunca se reduce.
*/
const CROP_W = 0.9;
const CROP_H = 0.35;
const MIN_ANALISIS_W = 1024; // si el recorte es más chico que esto, se amplía
const MAX_ANALISIS_W = 2400; // tope para no ahogar teléfonos viejos

async function construirHints() {
  const { DecodeHintType, BarcodeFormat } = await import('@zxing/library');
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
  return hints;
}

export default function Scanner({ onDetect, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [error, setError] = useState('');
  const [motor, setMotor] = useState('iniciando…');
  const [cuadros, setCuadros] = useState(0);
  const [tardando, setTardando] = useState(false);
  const [analizando, setAnalizando] = useState(false);
  const [linterna, setLinterna] = useState<boolean | null>(null); // null = no soportada

  async function decodificarFoto(file: File) {
    setAnalizando(true);
    setError('');
    const url = URL.createObjectURL(file);
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/library');
      const result = await new BrowserMultiFormatReader(await construirHints()).decodeFromImageUrl(url);
      navigator.vibrate?.(80);
      onDetect(result.getText().trim());
    } catch {
      setError('No se distinguió el código en la foto. Acércate más y que quede derecho.');
    } finally {
      URL.revokeObjectURL(url);
      setAnalizando(false);
    }
  }

  function alternarLinterna() {
    const track = trackRef.current;
    if (!track) return;
    const encender = !linterna;
    track
      .applyConstraints({ advanced: [{ torch: encender } as never] })
      .then(() => setLinterna(encender))
      .catch(() => setLinterna(null));
  }

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;
    let timer = 0;

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

      // Enfoque continuo y linterna si el equipo los soporta. El zoom NO se fuerza:
      // reencuadra sin avisar y estorba más de lo que ayuda.
      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      const caps = (track.getCapabilities?.() ?? {}) as Record<string, any>;
      const ajustes: unknown[] = [];
      if (caps.focusMode?.includes?.('continuous')) ajustes.push({ focusMode: 'continuous' });
      if (ajustes.length) await track.applyConstraints({ advanced: ajustes as never }).catch(() => {});
      if (caps.torch) setLinterna(false);

      // Lienzo donde se recorta y amplía la banda del marco.
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

      // modo: 'banda' recorta la guía, 'completo' analiza todo el cuadro.
      const recortar = (modo: 'banda' | 'completo', girado: boolean) => {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const cw = modo === 'banda' ? Math.round(vw * CROP_W) : vw;
        const ch = modo === 'banda' ? Math.round(vh * CROP_H) : vh;
        const sx = Math.round((vw - cw) / 2);
        const sy = Math.round((vh - ch) / 2);
        // Solo se amplía; reducir arruina las barras finas.
        const escala = Math.min(Math.max(1, MIN_ANALISIS_W / cw), MAX_ANALISIS_W / cw);
        const dw = Math.round(cw * escala);
        const dh = Math.round(ch * escala);

        if (girado) {
          canvas.width = dh;
          canvas.height = dw;
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(video, sx, sy, cw, ch, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
        } else {
          canvas.width = dw;
          canvas.height = dh;
          ctx.drawImage(video, sx, sy, cw, ch, 0, 0, dw, dh);
        }
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      };

      const Detector = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
      let detectarNativo: ((modo: 'banda' | 'completo', girado: boolean) => Promise<string | null>) | null = null;

      if (Detector) {
        try {
          const soportados: string[] = (await Detector.getSupportedFormats?.()) ?? [];
          const formats = FORMATS.filter((f) => soportados.includes(f));
          const detector = formats.length ? new Detector({ formats }) : new Detector();
          detectarNativo = async (modo, girado) => {
            const img = recortar(modo, girado);
            const bitmap = await createImageBitmap(img);
            const found = await detector.detect(bitmap);
            bitmap.close?.();
            return found?.length ? found[0].rawValue : null;
          };
          setMotor('cámara del sistema');
        } catch {
          detectarNativo = null;
        }
      }

      let decodificarZxing: ((modo: 'banda' | 'completo', girado: boolean) => string | null) | null = null;
      if (!detectarNativo) {
        const zxing = await import('@zxing/library');
        if (cancelado) return;
        const reader = new zxing.MultiFormatReader();
        reader.setHints(await construirHints());
        setMotor('ZXing');

        decodificarZxing = (modo, girado) => {
          const img = recortar(modo, girado);
          // RGBLuminanceSource quiere un byte de luminancia por píxel, no RGBA.
          const lum = new Uint8ClampedArray(img.width * img.height);
          for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
            lum[i] = (img.data[p] * 306 + img.data[p + 1] * 601 + img.data[p + 2] * 117) >> 10;
          }
          const source = new zxing.RGBLuminanceSource(lum, img.width, img.height);
          for (const s of [source, source.invert()]) {
            try {
              return reader.decode(new zxing.BinaryBitmap(new zxing.HybridBinarizer(s))).getText();
            } catch {
              /* este cuadro no trae código legible */
            } finally {
              reader.reset();
            }
          }
          return null;
        };
      }

      /*
        Se rota entre tres formas de mirar el mismo cuadro: la banda de la guía, esa
        banda girada 90° (códigos verticales) y el cuadro completo (por si el código
        quedó fuera del marco). Cualquiera que acierte, cierra el lector.
      */
      const PASADAS: [('banda' | 'completo'), boolean][] = [
        ['banda', false],
        ['banda', true],
        ['completo', false],
      ];

      let n = 0;
      const tick = async () => {
        if (cancelado) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const [modo, girado] = PASADAS[n % PASADAS.length];
          try {
            const code = detectarNativo
              ? await detectarNativo(modo, girado)
              : decodificarZxing
                ? decodificarZxing(modo, girado)
                : null;
            if (code) return exito(code);
          } catch {
            /* cuadro ilegible */
          }
          if (++n % 5 === 0) setCuadros(n);
        }
        timer = window.setTimeout(tick, 60);
      };
      tick();
    })();

    return () => {
      cancelado = true;
      clearTimeout(timer);
      clearTimeout(avisoLento);
      trackRef.current = null;
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
      <div className="flex items-center justify-between gap-2 p-4 text-white">
        <span className="truncate text-sm">
          Escanear{' '}
          <span className="text-white/50">
            · {motor}
            {cuadros ? ` · buscando (${cuadros})` : ''}
          </span>
        </span>
        <div className="flex shrink-0 gap-2">
          {linterna !== null && (
            <Button variant="secondary" onClick={alternarLinterna}>
              {linterna ? 'Luz on' : 'Luz'}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>Cerrar</Button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} muted playsInline autoPlay className="h-full w-full object-cover" />
        {/* Lo que se analiza es esta banda: el código debe llenarla a lo ancho */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[35%] w-[90%] rounded-lg border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
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
          'El código debe llenar el marco a lo ancho, derecho y a unos 10-15 cm. Si no, toma la foto.'
        ) : (
          'Llena el marco con el código de barras.'
        )}
      </p>
    </div>
  );
}
