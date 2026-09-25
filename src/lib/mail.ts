/**
 * El único lugar por donde el sistema manda correo (2026-09-21).
 *
 * Nació para el aviso de pago del módulo Pagos: «cuando se genere una OP
 * mandar un mail al contador y al proveedor con los comprobantes». Hasta hoy
 * el sistema no mandaba un solo mail, así que esto es la puerta entera.
 *
 * Sale por el SMTP de las casillas de la empresa (Hostinger), no por un
 * servicio de terceros: el remitente es una dirección real de CADINC, que es
 * lo que un proveedor espera ver, y no hay que tocar DNS ni contratar nada.
 *
 * TRES REGLAS, y las tres importan:
 *
 * 1. NUNCA loguear la contraseña ni el cuerpo del mail. `verificar()` y los
 *    errores devuelven el mensaje del servidor, que puede traer la casilla
 *    pero no la clave.
 * 2. Si no está configurado, NO explota: `estaConfigurado()` da false y quien
 *    llama decide. Un sistema sin SMTP tiene que seguir funcionando entero —
 *    el mail es un aviso, no el trabajo.
 * 3. Una sola conexión reutilizada (`pool`), y timeouts cortos. Un SMTP
 *    colgado no puede dejar una request esperando dos minutos.
 */
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

export interface AdjuntoMail {
  filename: string
  content:  Buffer
  contentType?: string
}

export interface MailAEnviar {
  para:     string
  asunto:   string
  /** Texto plano. Se manda SIEMPRE, junto al html: hay clientes que no lo pintan. */
  texto:    string
  html:     string
  adjuntos?: AdjuntoMail[]
  /** Para que las respuestas del proveedor caigan en una casilla que se lee. */
  responderA?: string
  /**
   * El NOMBRE que ve quien recibe («CADINC Pagos»), de la configuración de
   * Compras (20260929i). La DIRECCIÓN no se configura desde la pantalla: es
   * la de `SMTP_FROM` / `SMTP_USER`, que tiene que coincidir con la cuenta
   * SMTP o el servidor rechaza el envío.
   */
  nombreRemitente?: string
}

/**
 * Separa `SMTP_FROM` en nombre y dirección. Acepta «dir@x», «Nombre <dir@x>»
 * y «"Nombre" <dir@x>». Pura, para los tests.
 */
export function parsearFrom(from: string): { nombre: string; direccion: string } {
  const t = (from ?? '').trim()
  const m = t.match(/^\s*"?([^"<]*?)"?\s*<\s*([^<>\s]+)\s*>\s*$/)
  if (m) return { nombre: (m[1] ?? '').trim(), direccion: (m[2] ?? '').trim() }
  return { nombre: '', direccion: t }
}

/** Saca lo que rompería el encabezado From (comillas, <>, saltos de línea). */
function limpiarNombre(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * El From que sale: la dirección siempre del env; el nombre, el pedido (si
 * hay) o el que ya traía `SMTP_FROM`. Pura: recibe el `SMTP_FROM` efectivo.
 */
export function armarFrom(fromEnv: string, nombreRemitente?: string | null): { name: string; address: string } {
  const { nombre, direccion } = parsearFrom(fromEnv)
  return { name: limpiarNombre(nombreRemitente) || limpiarNombre(nombre), address: direccion }
}

/** Cómo se ve el From, para mostrarlo en la pantalla: «"Nombre" <dir@x>». */
export function fromComoTexto(f: { name: string; address: string }): string {
  if (!f.address) return ''
  return f.name ? `"${f.name}" <${f.address}>` : f.address
}

/** El From efectivo con este env y este nombre. '' si no hay dirección. */
export function remitenteEfectivo(nombreRemitente?: string | null): string {
  return fromComoTexto(armarFrom(cfg().from, nombreRemitente))
}

const cfg = () => ({
  host: process.env.SMTP_HOST ?? '',
  port: Number(process.env.SMTP_PORT ?? 465),
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASS ?? '',
  /** «CADINC SRL <pagos@cadinc.com.ar>». Si falta, se usa SMTP_USER. */
  from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
})

export function estaConfigurado(): boolean {
  const c = cfg()
  return !!(c.host && c.user && c.pass && c.from)
}

/** Lo que falta, para poder decirlo en la UI sin adivinar. */
export function loQueFalta(): string[] {
  const c = cfg()
  return [
    !c.host ? 'SMTP_HOST' : '',
    !c.user ? 'SMTP_USER' : '',
    !c.pass ? 'SMTP_PASS' : '',
    !c.from && !c.user ? 'SMTP_FROM' : '',
  ].filter(Boolean)
}

let transporter: Transporter | null = null

function getTransporter(): Transporter {
  if (transporter) return transporter
  const c = cfg()
  transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    // 465 es SSL directo; 587 arranca en claro y sube a TLS con STARTTLS.
    secure: c.port === 465,
    auth: { user: c.user, pass: c.pass },
    pool: true,
    maxConnections: 2,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })
  return transporter
}

/** Prueba la conexión y el login sin mandar nada. Para el diagnóstico de la UI. */
export async function verificar(): Promise<{ ok: boolean; error?: string }> {
  if (!estaConfigurado()) return { ok: false, error: `Falta configurar: ${loQueFalta().join(', ')}` }
  try {
    await getTransporter().verify()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'no se pudo conectar al servidor de correo' }
  }
}

/**
 * Manda uno. Lanza si falla — quien llama decide si eso tira abajo la
 * operación (en el aviso de pago NO: se registra el fallo y sigue).
 */
export async function enviarMail(m: MailAEnviar): Promise<{ messageId: string }> {
  if (!estaConfigurado()) {
    throw new Error(`El correo no está configurado en el servidor (falta ${loQueFalta().join(', ')})`)
  }
  const c = cfg()
  const f = armarFrom(c.from, m.nombreRemitente)
  const info = await getTransporter().sendMail({
    // Objeto y no texto: nodemailer codifica el nombre (tildes) y no hay forma
    // de inyectar otro encabezado desde la configuración.
    from: f.name ? { name: f.name, address: f.address } : f.address,
    to: m.para,
    replyTo: m.responderA ?? undefined,
    subject: m.asunto,
    text: m.texto,
    html: m.html,
    attachments: m.adjuntos?.map((a) => ({
      filename: a.filename, content: a.content, contentType: a.contentType,
    })),
  })
  return { messageId: String(info.messageId ?? '') }
}

/** Una dirección con forma de dirección. No valida que exista: eso lo dice el rebote. */
export function esEmailValido(s: string | null | undefined): boolean {
  const t = (s ?? '').trim()
  return t.length > 4 && t.length <= 254 && /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(t)
}
