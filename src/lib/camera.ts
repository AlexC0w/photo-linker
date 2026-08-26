// Separado del Scanner para que el lector (y ZXing) sigan siendo carga diferida.
export const puedeEscanear = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
