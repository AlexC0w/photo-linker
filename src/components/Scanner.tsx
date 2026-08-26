import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

/*
  Lector de código de barras con la cámara.

  Android/Chrome trae BarcodeDetector nativo: es rápido y no pesa nada.
  iOS/Safari no lo tiene, así que ahí se carga ZXing bajo demanda (import dinámico,
  para que no engorde el bundle de quien nunca abre el lector).

  La cámara solo funciona en HTTPS (o localhost); si no, se avisa en vez de fallar callado.
*/

type Props = {
  onDetect: (code: string) => void;
  onClose: () => void;
};

// Formatos de tienda: EAN/UPC para producto, Code128/39 e ITF para etiquetas internas.
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'] as const;

export default function Scanner({ onDetect, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [motor, setMotor] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;
    let raf = 0;
    let zxingControls: { stop: () => void } | null = null;

    const exito = (code: string) => {
      if (cancelado || !code) return;
      cancelado = true;
      navigator.vibrate?.(80);
      onDetect(code.trim());
    };

    (async () => {
      if (!window.isSecureContext) {
        setError('La cámara necesita HTTPS. Abre la app por su dominio seguro, no por IP.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        setError('No se pudo abrir la cámara. Revisa el permiso en el navegador.');
        return;
      }
      if (cancelado) return stream.getTracks().forEach((t) => t.stop());

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true'); // iOS: sin esto abre en pantalla completa
      await video.play().catch(() => {});

      const Detector = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
      if (Detector) {
        setMotor('cámara del sistema');
        const soportados: string[] = await Detector.getSupportedFormats?.().catch(() => []) ?? [];
        const formats = FORMATS.filter((f) => !soportados.length || soportados.includes(f));
        const detector = new Detector({ formats });

        const tick = async () => {
          if (cancelado) return;
          try {
            const found = await detector.detect(video);
            if (found?.length) return exito(found[0].rawValue);
          } catch {
            /* un cuadro ilegible no es un error: se sigue intentando */
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return;
      }

      // iOS y navegadores sin BarcodeDetector
      setMotor('ZXing');
      const { BrowserMultiFormatReader } = await import('@zxing/library');
      if (cancelado) return;
      const reader = new BrowserMultiFormatReader();
      zxingControls = { stop: () => reader.reset() };
      // El stream ya está abierto y pintándose: se decodifica sobre ese <video>.
      reader.decodeFromVideoElementContinuously(video, (result) => {
        if (result) exito(result.getText());
      });
    })();

    return () => {
      cancelado = true;
      cancelAnimationFrame(raf);
      zxingControls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onDetect]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-4 text-white">
        <span className="text-sm">
          Escanear código {motor && <span className="text-white/50">· {motor}</span>}
        </span>
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
        {/* Guía: el código se lee mejor centrado y llenando el ancho */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-32 w-[85%] rounded-xl border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
        </div>
      </div>

      <p className="p-4 text-center text-sm text-white/70">
        {error || 'Apunta al código de barras. Se cierra solo al leerlo.'}
      </p>
    </div>
  );
}
