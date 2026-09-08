import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireFlag } from '../../middleware/permission.js'
import { ChatBodySchema } from './asistente.schema.js'
import { asistenteService, AsistenteError } from './asistente.service.js'

// Asistente IA v1 — visible solo para admins + flag permisos.tarja.asistente_ia
// (mismo patrón que costos_oficina). requireFlag hace bypass de admin y
// devuelve 403 { error: 'SIN_PERMISO' } al resto sin el flag.
const asistente = new Hono()

/**
 * Freno de abuso por usuario y día, en memoria.
 *
 * No es una cuota: es que ahora el asistente puede ESCRIBIR pedidos, y cada
 * mensaje cuesta plata de API. Se resetea en cada deploy de Render y con eso
 * alcanza — nadie manda 80 mensajes en un día haciendo su trabajo.
 */
const TOPE_DIARIO = 80
const usos = new Map<string, { dia: string; n: number }>()

function pasaElTope(userId: string): boolean {
  const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
  const actual = usos.get(userId)
  if (!actual || actual.dia !== dia) { usos.set(userId, { dia, n: 1 }); return true }
  actual.n++
  return actual.n <= TOPE_DIARIO
}

asistente.use('*', authMiddleware)
asistente.use('*', requireFlag('tarja', 'asistente_ia'))

// POST /api/asistente/chat — contrato fijo (ver asistente.schema.ts).
// 200 { reply, herramientas_usadas } · 400 zod · 403 permisos ·
// 503 { error: 'ASISTENTE_NO_CONFIGURADO' } si falta ANTHROPIC_API_KEY.
asistente.post('/chat', zValidator('json', ChatBodySchema), async (c) => {
  const body = c.req.valid('json')
  if (!pasaElTope(c.get('user').id)) {
    return c.json({ error: 'DEMASIADAS_CONSULTAS' }, 429)
  }
  try {
    const resultado = await asistenteService.chat(
      body.messages,
      c.get('user').id,
      c.get('accessToken'),
    )
    return c.json(resultado)
  } catch (err) {
    if (err instanceof AsistenteError) {
      return c.json({ error: err.code }, err.status)
    }
    throw err // → app.onError (500 genérico)
  }
})

export default asistente
