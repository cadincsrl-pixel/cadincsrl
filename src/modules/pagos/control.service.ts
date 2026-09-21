/**
 * Control automático del comprobante contra lo que se tipeó (20260921j).
 *
 * Se dispara SOLO al registrar un adjunto de tipo 'factura'. Nadie lo pide:
 * es el pedido del dueño después de que revisar a mano las 5 primeras
 * facturas encontrara 3 errores —un punto de venta cambiado, dos sin número
 * y un total con 48 centavos de más—.
 *
 * DOS DATOS Y NADA MÁS: número y total. Son los que, mal cargados, hacen
 * pagar mal o pagar dos veces. Pedirle menos al modelo es pedirle algo que
 * puede hacer bien; una extracción completa de la factura sería otro problema
 * y con otra tasa de error.
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
  nota:          string
  modelo:        string
}

/** Lo único que se le pide al modelo. Cualquier otra forma se descarta. */
interface LecturaCruda {
  legible?: boolean
  numero?:  string | null
  total?:   number | string | null
}

const MIME_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const PROMPT = `Sos un asistente que lee facturas de proveedor argentinas.

Mirá el comprobante adjunto y devolvé SOLO un objeto JSON, sin texto alrededor
y sin bloque de código, con exactamente estas claves:

{"legible": true|false, "numero": "<punto de venta>-<número>" | null, "total": <number> | null}

Reglas:
- "numero": el número del comprobante como figura impreso, con el punto de
  venta primero. En las facturas argentinas suele aparecer como
  "Nro.: 00011-00000194", "NUMERO: 0012 00402141", "NRO.COMP: 08837-00004557"
  o "Factura N°: 00002 - 00032168". Devolvelo siempre con guion y con los
  ceros que tenga impresos. Si no lo ves con seguridad, poné null.
- "total": el TOTAL FINAL a pagar, el de más abajo, el que incluye IVA y
  percepciones. Como número, con punto decimal y sin separador de miles ni
  símbolo: 24994.52. Si no lo ves con seguridad, poné null.
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
 * Compara lo leído con lo cargado y arma el veredicto.
 *
 * El número se compara NORMALIZADO con la misma función que usa el módulo
 * para detectar duplicados: así "0012 00402141" del papel y "0012-00402141"
 * de la pantalla son lo mismo, que es lo correcto.
 *
 * El total se compara en centavos: 24994.52 y 24994.520000001 son iguales.
 */
export function compararLectura(
  lectura: LecturaCruda,
  facturaNumero: string | null,
  facturaTotal: number,
): Omit<ControlFactura, 'factura_id' | 'adjunto_id' | 'modelo'> {
  const numeroLeido = typeof lectura.numero === 'string' && lectura.numero.trim() ? lectura.numero.trim() : null
  const totalLeido = aNumero(lectura.total)

  if (lectura.legible === false || (numeroLeido === null && totalLeido === null)) {
    return {
      estado: 'ilegible', numero_leido: numeroLeido, total_leido: totalLeido,
      numero_ok: null, total_ok: null,
      nota: 'No se pudo leer el comprobante con confianza. Revisalo a mano.',
    }
  }

  const numeroOk = numeroLeido === null ? null
    : normNumeroFactura(numeroLeido) === normNumeroFactura(facturaNumero)
  const totalOk = totalLeido === null ? null
    : aCentavos(totalLeido) === aCentavos(facturaTotal)

  const problemas: string[] = []
  if (numeroOk === false) problemas.push(`el comprobante dice N° ${numeroLeido} y está cargado ${facturaNumero ?? 'sin número'}`)
  if (totalOk === false)  problemas.push(`el comprobante dice $${totalLeido} y está cargado $${facturaTotal}`)

  if (problemas.length > 0) {
    return {
      estado: 'difiere', numero_leido: numeroLeido, total_leido: totalLeido,
      numero_ok: numeroOk, total_ok: totalOk,
      nota: problemas.join(' · '),
    }
  }

  // Coincide lo que se pudo leer. Si uno de los dos no se leyó, se dice.
  const sinLeer = [numeroOk === null ? 'el número' : null, totalOk === null ? 'el total' : null].filter(Boolean)
  return {
    estado: 'coincide', numero_leido: numeroLeido, total_leido: totalLeido,
    numero_ok: numeroOk, total_ok: totalOk,
    nota: sinLeer.length > 0 ? `Coincide, pero no se pudo leer ${sinLeer.join(' ni ')}.` : '',
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
export async function controlarFactura(
  facturaId: number,
  adjuntoId: number | null,
  storagePath: string,
  mime: string,
): Promise<ControlFactura | null> {
  const modelo = process.env.PAGOS_CONTROL_MODEL ?? process.env.ASISTENTE_MODEL ?? 'claude-sonnet-5'
  const guardar = async (c: Omit<ControlFactura, 'factura_id' | 'adjunto_id' | 'modelo'>) => {
    const fila: ControlFactura = { ...c, factura_id: facturaId, adjunto_id: adjuntoId, modelo }
    const { data } = await supabase.from('pagos_facturas_control').insert(fila).select('*').single()
    return (data as ControlFactura | null) ?? fila
  }

  try {
    if (!process.env.ANTHROPIC_API_KEY) return null   // sin key, el módulo anda igual: no se controla

    const { data: f } = await supabase
      .from('pagos_facturas').select('numero, total').eq('id', facturaId).maybeSingle()
    if (!f) return null

    const bajada = await supabase.storage.from(BUCKET).download(storagePath)
    if (bajada.error || !bajada.data) {
      return guardar({
        estado: 'error', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null,
        nota: 'No se pudo abrir el archivo para controlarlo.',
      })
    }

    const base64 = Buffer.from(await bajada.data.arrayBuffer()).toString('base64')
    const bloque = bloqueDelArchivo(base64, mime)
    if (!bloque) {
      return guardar({
        estado: 'ilegible', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null,
        nota: `El control no sabe leer archivos ${mime}.`,
      })
    }

    const client = new Anthropic({ timeout: 90_000, maxRetries: 1 })
    const r = await client.messages.create({
      model: modelo,
      max_tokens: 300,
      messages: [{ role: 'user', content: [bloque, { type: 'text', text: PROMPT }] }],
    })
    const texto = r.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    const lectura = parsearJson(texto)
    if (!lectura) {
      return guardar({
        estado: 'error', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null,
        nota: 'El control no devolvió una respuesta que se pueda leer.',
      })
    }

    const fila = f as { numero: string | null; total: number | string }
    return guardar(compararLectura(lectura, fila.numero, Number(fila.total)))
  } catch (e) {
    // Nunca romper la carga: el adjunto ya está guardado.
    try {
      return await guardar({
        estado: 'error', numero_leido: null, total_leido: null, numero_ok: null, total_ok: null,
        nota: `No se pudo controlar: ${e instanceof Error ? e.message : 'error desconocido'}`,
      })
    } catch { return null }
  }
}

/** El último control de una factura, para mostrarlo en la ficha. */
export async function ultimoControl(facturaId: number): Promise<ControlFactura | null> {
  const { data } = await supabase
    .from('pagos_facturas_control').select('*')
    .eq('factura_id', facturaId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as ControlFactura | null) ?? null
}
