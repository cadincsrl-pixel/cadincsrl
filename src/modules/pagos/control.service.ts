/**
 * Control automático del comprobante contra lo que se tipeó (20260921j).
 *
 * Se dispara SOLO al registrar un adjunto de tipo 'factura'. Nadie lo pide:
 * es el pedido del dueño después de que revisar a mano las 5 primeras
 * facturas encontrara 3 errores —un punto de venta cambiado, dos sin número
 * y un total con 48 centavos de más—.
 *
 * TRES DATOS Y NADA MÁS: número, total y fecha de emisión. Número y total
 * son los que, mal cargados, hacen pagar mal o pagar dos veces; la fecha se
 * sumó el 23/09 (20260923a) porque las 13 facturas cargadas tenían la fecha
 * del día de carga — el modal propone hoy y nadie la cambia — y una vez
 * pagada queda congelada. Pedirle poco al modelo es pedirle algo que puede
 * hacer bien; una extracción completa de la factura sería otro problema y
 * con otra tasa de error.
 *
 * AVISA, NO BLOQUEA. Todo acá adentro está envuelto: si la llamada falla, si
 * el PDF es ilegible o si el modelo devuelve cualquier cosa, se guarda el
 * estado correspondiente y la factura queda cargada igual. Una foto de papel
 * arrugado no puede frenar una factura real.
 *
 * Y «no pude leerlo» NO es «está bien»: `ilegible` y `error` son estados
 * propios, distintos de `coincide`, justamente para que nadie los lea como un
 * visto bueno.
 */
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../lib/supabase.js'
import { BUCKET } from './adjuntos.service.js'
import { normNumeroFactura, aCentavos } from './pagos.util.js'
import { MODELO_LECTURA_DEFAULT } from './lectura/ia.js'

export type EstadoControl = 'coincide' | 'difiere' | 'ilegible' | 'error'

export interface ControlFactura {
  id?:           number
  factura_id:    number
  adjunto_id:    number | null
  estado:        EstadoControl
  numero_leido:  string | null
  total_leido:   number | null
  numero_ok:     boolean | null
  total_ok:      boolean | null
  fecha_leida:   string | null
  fecha_ok:      boolean | null
  nota:          string
  modelo:        string
}

/** Lo único que se le pide al modelo. Cualquier otra forma se descarta. */
interface LecturaCruda {
  legible?: boolean
  numero?:  string | null
  total?:   number | string | null
  fecha?:   string | null
}

const MIME_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const PROMPT = `Sos un asistente que lee facturas de proveedor argentinas.

Mirá el comprobante adjunto y devolvé SOLO un objeto JSON, sin texto alrededor
y sin bloque de código, con exactamente estas claves:

{"legible": true|false, "numero": "<punto de venta>-<número>" | null, "total": <number> | null, "fecha": "AAAA-MM-DD" | null}

Reglas:
- "numero": el número del comprobante como figura impreso, con el punto de
  venta primero. En las facturas argentinas suele aparecer como
  "Nro.: 00011-00000194", "NUMERO: 0012 00402141", "NRO.COMP: 08837-00004557"
  o "Factura N°: 00002 - 00032168". Devolvelo siempre con guion y con los
  ceros que tenga impresos. Si no lo ves con seguridad, poné null.
- "total": el TOTAL FINAL a pagar, el de más abajo, el que incluye IVA y
  percepciones. Como número, con punto decimal y sin separador de miles ni
  símbolo: 24994.52. Si no lo ves con seguridad, poné null.
- "fecha": la FECHA DE EMISIÓN del comprobante (suele decir "Fecha:",
  "Fecha de emisión" o "Fecha Emisión"), en formato AAAA-MM-DD. En Argentina
  se imprime día/mes/año: "18/09/2026" es 2026-09-18. No confundir con el
  vencimiento del CAE, el período facturado ni la fecha de vencimiento del
  pago. Si no la ves con seguridad, poné null.
- "legible": false si el comprobante está tan borroso, cortado o torcido que
  no podés leerlo con confianza.

No inventes. Ante la duda, null. Es preferible decir que no se puede leer a
arriesgar un número equivocado.`

/** El primer objeto JSON del texto, o null. El modelo a veces agrega prosa. */
function parsearJson(texto: string): LecturaCruda | null {
  const i = texto.indexOf('{')
  const j = texto.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try {
    const v = JSON.parse(texto.slice(i, j + 1))
    return v && typeof v === 'object' ? (v as LecturaCruda) : null
  } catch {
    return null
  }
}

/** "24.994,52" | "24994.52" | 24994.52 → 24994.52. null si no es un número. */
export function aNumero(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim().replace(/[^\d.,-]/g, '')
  if (!t) return null
  // Si tiene coma, la coma es el decimal y los puntos son miles.
  const limpio = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t
  const n = Number(limpio)
  return Number.isFinite(n) ? n : null
}

/**
 * "2026-09-18" | "18/09/2026" | "18-09-26" → "2026-09-18". null si no es una
 * fecha que exista (un 31/02 no pasa). El papel argentino es día/mes/año.
 */
export function aFecha(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  let a: number, m: number, d: number
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (r) { a = Number(r[1]); m = Number(r[2]); d = Number(r[3]) }
  else {
    r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t)
    if (!r) return null
    const anio = r[3] ?? ''
    d = Number(r[1]); m = Number(r[2]); a = anio.length === 2 ? 2000 + Number(anio) : Number(anio)
  }
  const f = new Date(Date.UTC(a, m - 1, d))
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** "2026-09-18" → "18/09/2026", como se lee en el papel. */
const fechaAR = (iso: string) => iso.split('-').reverse().join('/')

/**
 * Compara lo leído con lo cargado y arma el veredicto.
 *
 * El número se compara NORMALIZADO con la misma función que usa el módulo
 * para detectar duplicados: así "0012 00402141" del papel y "0012-00402141"
 * de la pantalla son lo mismo, que es lo correcto.
 *
 * El total se compara en centavos: 24994.52 y 24994.520000001 son iguales.
 *
 * La fecha se compara sólo si se pasa `facturaFecha` (undefined = el llamador
 * no la controla, que es lo que hacían los controles anteriores al 23/09).
 */
export function compararLectura(
  lectura: LecturaCruda,
  facturaNumero: string | null,
  facturaTotal: number,
  facturaFecha?: string | null,
): Omit<ControlFactura, 'factura_id' | 'adjunto_id' | 'modelo'> {
  const numeroLeido = typeof lectura.numero === 'string' && lectura.numero.trim() ? lectura.numero.trim() : null
  const totalLeido = aNumero(lectura.total)
  const fechaLeida = aFecha(lectura.fecha)

  if (lectura.legible === false || (numeroLeido === null && totalLeido === null && fechaLeida === null)) {
    return {
      estado: 'ilegible', numero_leido: numeroLeido, total_leido: totalLeido,
      numero_ok: null, total_ok: null, fecha_leida: fechaLeida, fecha_ok: null,
      nota: 'No se pudo leer el comprobante con confianza. Revisalo a mano.',
    }
  }

  const numeroOk = numeroLeido === null ? null
    : normNumeroFactura(numeroLeido) === normNumeroFactura(facturaNumero)
  const totalOk = totalLeido === null ? null
    : aCentavos(totalLeido) === aCentavos(facturaTotal)
  const controlaFecha = facturaFecha !== undefined
  const fechaOk = !controlaFecha || fechaLeida === null ? null
    : fechaLeida === String(facturaFecha ?? '').slice(0, 10)

  const problemas: string[] = []
  if (numeroOk === false) problemas.push(`el comprobante dice N° ${numeroLeido} y está cargado ${facturaNumero ?? 'sin número'}`)
  if (totalOk === false)  problemas.push(`el comprobante dice $${totalLeido} y está cargado $${facturaTotal}`)
  if (fechaOk === false)  problemas.push(`el comprobante dice emitida el ${fechaAR(fechaLeida!)} y está cargada el ${facturaFecha ? fechaAR(String(facturaFecha).slice(0, 10)) : 'sin fecha'}`)

  if (problemas.length > 0) {
    return {
      estado: 'difiere', numero_leido: numeroLeido, total_leido: totalLeido,
      numero_ok: numeroOk, total_ok: totalOk, fecha_leida: fechaLeida, fecha_ok: fechaOk,
      nota: problemas.join(' · '),
    }
  }

  // Coincide lo que se pudo leer. Si alguno no se leyó, se dice.
  const sinLeer = [
    numeroOk === null ? 'el número' : null,
    totalOk === null ? 'el total' : null,
    controlaFecha && fechaOk === null ? 'la fecha' : null,
  ].filter(Boolean)
  return {
    estado: 'coincide', numero_leido: numeroLeido, total_leido: totalLeido,
    numero_ok: numeroOk, total_ok: totalOk, fecha_leida: fechaLeida, fecha_ok: fechaOk,
    nota: sinLeer.length > 0 ? `Coincide, pero no se pudo leer ${sinLeer.length > 1 ? sinLeer.slice(0, -1).join(', ') + ' ni ' + sinLeer[sinLeer.length - 1] : sinLeer[0]}.` : '',
  }
}

/** El bloque de contenido que entiende la API según el tipo de archivo. */
function bloqueDelArchivo(base64: string, mime: string): Anthropic.ContentBlockParam | null {
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
  }
  if (MIME_IMAGEN.has(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg', data: base64 } }
  }
  return null
}

/**
 * Lee el comprobante y guarda el control. NUNCA lanza: cualquier problema
 * termina en una fila con estado 'error' o 'ilegible'.
 */
/** Los Haiku no aceptan el parámetro `effort`; Opus y Sonnet 5 sí. */
export const admiteEffort = (modelo: string) => !/haiku/i.test(modelo)

export async function controlarFactura(
  facturaId: number,
  adjuntoId: number | null,
  storagePath: string,
  mime: string,
): Promise<ControlFactura | null> {
  // 2026-09-24: por defecto el mismo modelo que la lectura completa
  // (claude-opus-5) y ya no el del asistente: son tareas distintas y
  // compartir la variable hacía que cambiar uno moviera el otro.
  const modelo = process.env.PAGOS_CONTROL_MODEL ?? process.env.PAGOS_LECTURA_MODEL ?? MODELO_LECTURA_DEFAULT
  const guardar = async (c: Omit<ControlFactura, 'factura_id' | 'adjunto_id' | 'modelo'>) => {
    const fila: ControlFactura = { ...c, factura_id: facturaId, adjunto_id: adjuntoId, modelo }
    const { data } = await supabase.from('pagos_facturas_control').insert(fila).select('*').single()
    return (data as ControlFactura | null) ?? fila
  }

  try {
    if (!process.env.ANTHROPIC_API_KEY) return null   // sin key, el módulo anda igual: no se controla

    const { data: f } = await supabase
      .from('pagos_facturas').select('numero, total, fecha').eq('id', facturaId).maybeSingle()
    if (!f) return null

    const bajada = await supabase.storage.from(BUCKET).download(storagePath)
    if (bajada.error || !bajada.data) {
      return guardar({
        estado: 'error', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null, fecha_leida: null, fecha_ok: null,
        nota: 'No se pudo abrir el archivo para controlarlo.',
      })
    }

    const base64 = Buffer.from(await bajada.data.arrayBuffer()).toString('base64')
    const bloque = bloqueDelArchivo(base64, mime)
    if (!bloque) {
      return guardar({
        estado: 'ilegible', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null, fecha_leida: null, fecha_ok: null,
        nota: `El control no sabe leer archivos ${mime}.`,
      })
    }

    const client = new Anthropic({ timeout: 90_000, maxRetries: 1 })
    // Con claude-opus-5 el razonamiento está prendido por defecto: esfuerzo
    // bajo (son tres datos) y margen de tokens para que no se corte antes
    // del JSON.
    // Haiku 4.5 rechaza `effort` con 400 («This model does not support the
    // effort parameter», probado 24/09): sin esta guarda, poner Haiku en
    // PAGOS_CONTROL_MODEL dejaba cada control en «error».
    const r = await client.messages.create({
      model: modelo,
      max_tokens: 4000,
      ...(admiteEffort(modelo) ? { output_config: { effort: 'low' as const } } : {}),
      messages: [{ role: 'user', content: [bloque, { type: 'text', text: PROMPT }] }],
    })
    const texto = r.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    const lectura = parsearJson(texto)
    if (!lectura) {
      return guardar({
        estado: 'error', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null, fecha_leida: null, fecha_ok: null,
        nota: 'El control no devolvió una respuesta que se pueda leer.',
      })
    }

    const fila = f as { numero: string | null; total: number | string; fecha: string }
    return guardar(compararLectura(lectura, fila.numero, Number(fila.total), fila.fecha))
  } catch (e) {
    // Nunca romper la carga: el adjunto ya está guardado.
    try {
      return await guardar({
        estado: 'error', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null, fecha_leida: null, fecha_ok: null,
        nota: `No se pudo controlar: ${e instanceof Error ? e.message : 'error desconocido'}`,
      })
    } catch { return null }
  }
}

/**
 * Control a partir de una lectura ya hecha (20260924u): la factura se cargó
 * «archivo primero», así que el papel ya se leyó —QR de ARCA y/o IA— antes
 * de guardar. No se vuelve a llamar al modelo: se compara lo leído contra lo
 * que quedó cargado (la persona pudo corregir la propuesta) y se guarda la
 * misma fila de siempre, con los mismos estados. Nunca lanza.
 */
export async function controlDesdeLectura(
  facturaId: number,
  adjuntoId: number | null,
  leido: { numero: string | null; total: number | null; fecha: string | null },
  modelo: string,
): Promise<ControlFactura | null> {
  try {
    const { data: f } = await supabase
      .from('pagos_facturas').select('numero, total, fecha').eq('id', facturaId).maybeSingle()
    if (!f) return null
    const fila = f as { numero: string | null; total: number | string; fecha: string }
    const r = compararLectura(
      { legible: true, numero: leido.numero, total: leido.total, fecha: leido.fecha },
      fila.numero, Number(fila.total), fila.fecha)
    const nueva: ControlFactura = { ...r, factura_id: facturaId, adjunto_id: adjuntoId, modelo }
    const { data } = await supabase.from('pagos_facturas_control').insert(nueva).select('*').single()
    return (data as ControlFactura | null) ?? nueva
  } catch {
    return null
  }
}

/** El último control de una factura, para mostrarlo en la ficha. */
export async function ultimoControl(facturaId: number): Promise<ControlFactura | null> {
  const { data } = await supabase
    .from('pagos_facturas_control').select('*')
    .eq('factura_id', facturaId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as ControlFactura | null) ?? null
}

/**
 * Vuelve a comparar el último control contra la factura TAL COMO QUEDÓ, sin
 * llamar al modelo: lo leído del papel no cambia, lo tipeado sí. Se usa
 * después de editar número, total o fecha, para que el chip «difiere» se
 * apague cuando se corrige (y se prenda si se rompe). Deja una fila nueva con
 * `modelo = 'recomparado'`, así queda el rastro de cuándo se corrigió.
 *
 * Sólo re-compara controles que leyeron algo: `ilegible` y `error` no tienen
 * nada contra qué comparar. Nunca lanza.
 */
export async function recompararControl(facturaId: number): Promise<ControlFactura | null> {
  try {
    const previo = await ultimoControl(facturaId)
    if (!previo || previo.estado === 'ilegible' || previo.estado === 'error') return null

    const { data: f } = await supabase
      .from('pagos_facturas').select('numero, total, fecha').eq('id', facturaId).maybeSingle()
    if (!f) return null
    const fila = f as { numero: string | null; total: number | string; fecha: string }

    const r = compararLectura(
      { legible: true, numero: previo.numero_leido, total: previo.total_leido, fecha: previo.fecha_leida },
      fila.numero, Number(fila.total),
      // Los controles anteriores al 23/09 no leían la fecha: no inventar un «no se pudo leer».
      previo.fecha_leida ? fila.fecha : undefined,
    )
    const nueva: ControlFactura = { ...r, factura_id: facturaId, adjunto_id: previo.adjunto_id, modelo: 'recomparado' }
    const { data } = await supabase.from('pagos_facturas_control').insert(nueva).select('*').single()
    return (data as ControlFactura | null) ?? nueva
  } catch {
    return null
  }
}
