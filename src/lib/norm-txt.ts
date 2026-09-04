// Espejo EXACTO de public.norm_txt() (migración 20260904a).
//
// La base guarda columnas normalizadas con esa función (`descripcion_norm` de
// las entregas del pañol, `busq` del catálogo de precios), así que el texto que
// se busca tiene que normalizarse igual o el ilike no pega nunca. Si allá
// cambia, acá también. Usar String.normalize('NFD') parece equivalente y NO lo
// es: saca acentos que el translate de SQL deja pasar.
const NORM_FROM = 'áéíóúüñàèìòùç'
const NORM_TO   = 'aeiouunaeiouc'

export function normTxt(t: string): string {
  return Array.from(t.toLowerCase())
    .map(ch => { const i = NORM_FROM.indexOf(ch); return i >= 0 ? NORM_TO[i] : ch })
    .join('')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
