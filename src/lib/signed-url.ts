// Opciones de `createSignedUrl` según el tipo de archivo: ¿se abre en el
// navegador o se descarga?
//
// Con `{ download }` Supabase responde `Content-Disposition: attachment` y el
// navegador baja el archivo aunque sea un PDF o una foto. El dueño quiere
// VERLOS (2026-09-25): PDF e imágenes se abren inline (sin `download`); todo lo
// demás se sigue bajando con su nombre original. `?descargar=1` en la ruta
// fuerza la descarga para cualquier tipo.
//
// Seguridad: solo una lista blanca se muestra inline. HTML, SVG, XML y
// cualquier cosa que el navegador pueda ejecutar se bajan SIEMPRE, aunque el
// mime diga otra cosa: un HTML inline correría script en el dominio del
// storage. Todas las señales presentes (mime, extensión del path, extensión
// del nombre) tienen que ser visibles para abrir inline.

const MIMES_VISIBLES = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/pjpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic', 'image/heif',
  'text/plain',
])

const EXT_VISIBLES = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'txt'])

// Extensiones que nunca se abren inline, aunque el resto de las señales digan
// que sí (un nombre «foto.jpg.html» o «plano.svg»).
const EXT_PELIGROSAS = new Set(['html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'swf'])

function extension(nombre: string | null | undefined): string | null {
  if (!nombre) return null
  const base = nombre.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  if (i <= 0 || i === base.length - 1) return null
  const ext = base.slice(i + 1).toLowerCase()
  // «Factura 0001.00001234» no tiene extensión: son dígitos o texto largo.
  return /^[a-z][a-z0-9]{0,4}$/.test(ext) ? ext : null
}

function mimeBase(mime: string | null | undefined): string | null {
  if (!mime) return null
  const m = (mime.split(';')[0] ?? '').trim().toLowerCase()
  return m || null
}

export interface ArchivoFirmado {
  /** Nombre original (el que se usa para la descarga). */
  nombre?: string | null
  /** Path en el bucket; la extensión la pone el backend a partir del mime validado. */
  path?: string | null
  /** Mime declarado al subir, si la tabla lo guarda. */
  mime?: string | null
  /** `?descargar=1`: bajar siempre, sea del tipo que sea. */
  descargar?: boolean
}

/** ¿Se puede mostrar inline? (lista blanca; ante la duda, no). */
export function esVisibleInline(a: Omit<ArchivoFirmado, 'descargar'>): boolean {
  const mime = mimeBase(a.mime)
  const extPath = extension(a.path)
  const extNombre = extension(a.nombre)

  if ([extPath, extNombre].some(e => e && EXT_PELIGROSAS.has(e))) return false
  if (mime && !MIMES_VISIBLES.has(mime)) return false
  if (extPath && !EXT_VISIBLES.has(extPath)) return false
  // El nombre lo tipea el usuario: solo decide cuando no hay mime ni path con extensión.
  if (!mime && !extPath) return !!extNombre && EXT_VISIBLES.has(extNombre)
  return true
}

/**
 * Tercer argumento de `createSignedUrl`. `undefined` = inline (el navegador
 * muestra el PDF o la imagen); `{ download }` = se baja con su nombre.
 */
export function opcionesSignedUrl(a: ArchivoFirmado): { download: string | true } | undefined {
  if (!a.descargar && esVisibleInline(a)) return undefined
  return { download: a.nombre?.trim() || true }
}

/** Lee `?descargar=`: `1`, `true`, `si`/`sí` fuerzan la descarga. */
export function quiereDescargar(v: string | null | undefined): boolean {
  if (!v) return false
  return ['1', 'true', 'si', 'sí'].includes(v.trim().toLowerCase())
}
