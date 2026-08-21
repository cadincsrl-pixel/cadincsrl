import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireFlag } from '../../middleware/permission.js'
import { oficinaService } from './oficina.service.js'
import {
  CreatePersonaSchema,
  UpdatePersonaSchema,
  CreateSueldoSchema,
  PutAsignacionesSchema,
  AplicarAumentoSchema,
  ResumenQuerySchema,
  ASIGNACIONES_ERROR_CODES,
} from './oficina.schema.js'

// Costos de oficina = sueldos administrativos → dato sensible. TODO el router
// va detrás del flag `tarja.costos_oficina` (GETs incluidos). Admin bypass
// dentro de requireFlag. Auditoría: la cubre el auditMiddleware global.
const oficina = new Hono()
oficina.use('*', authMiddleware)
oficina.use('*', requireFlag('tarja', 'costos_oficina'))

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

// ── Personas ──

oficina.get('/personas', async (c) => {
  const data = await oficinaService.getPersonas()
  return c.json(data)
})

oficina.post('/personas', zValidator('json', CreatePersonaSchema), async (c) => {
  const data = await oficinaService.createPersona(c.req.valid('json'), c.get('user').id)
  return c.json(data, 201)
})

oficina.patch('/personas/:id', zValidator('json', UpdatePersonaSchema), async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'ID_INVALIDO' }, 400)
  try {
    const data = await oficinaService.updatePersona(id, c.req.valid('json'), c.get('user').id)
    return c.json(data)
  } catch (err: any) {
    if (err?.code === 'PERSONA_NO_EXISTE') return c.json({ error: 'PERSONA_NO_EXISTE' }, 404)
    throw err
  }
})

// ── Sueldos (versionado por desde, estilo categoria_tarifas) ──

oficina.post('/personas/:id/sueldos', zValidator('json', CreateSueldoSchema), async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'ID_INVALIDO' }, 400)
  try {
    const data = await oficinaService.upsertSueldo(id, c.req.valid('json'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    if (err?.code === 'PERSONA_NO_EXISTE') return c.json({ error: 'PERSONA_NO_EXISTE' }, 404)
    throw err
  }
})

// Aumento masivo: versión nueva de sueldo para varias personas a la vez
// (% global o distinto por persona; se resuelve en el body).
oficina.post('/sueldos/aumento', zValidator('json', AplicarAumentoSchema), async (c) => {
  try {
    const data = await oficinaService.aplicarAumento(c.req.valid('json'), c.get('user').id)
    return c.json(data, 201)
  } catch (err: any) {
    if (err?.code === 'PERSONA_DUPLICADA') return c.json({ error: 'PERSONA_DUPLICADA' }, 400)
    if (err?.code === 'PERSONA_NO_EXISTE') return c.json({ error: 'PERSONA_NO_EXISTE' }, 404)
    if (err?.code === 'SIN_SUELDO_BASE')   return c.json({ error: 'SIN_SUELDO_BASE', detail: err.detail }, 400)
    throw err
  }
})

// ── Asignaciones (snapshots de distribución por desde) ──

oficina.get('/personas/:id/asignaciones', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'ID_INVALIDO' }, 400)
  try {
    const data = await oficinaService.getAsignaciones(id)
    return c.json(data)
  } catch (err: any) {
    if (err?.code === 'PERSONA_NO_EXISTE') return c.json({ error: 'PERSONA_NO_EXISTE' }, 404)
    throw err
  }
})

oficina.put(
  '/personas/:id/asignaciones',
  // El superRefine del schema emite códigos de negocio como `message`; el
  // hook los mapea al shape { error: CODE } que espera el frontend (el
  // default del zValidator devolvería el ZodError crudo).
  zValidator('json', PutAsignacionesSchema, (result, c) => {
    if (!result.success) {
      const code = result.error.issues
        .map((i) => i.message)
        .find((m) => (ASIGNACIONES_ERROR_CODES as readonly string[]).includes(m))
      if (code) return c.json({ error: code }, 400)
    }
  }),
  async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'ID_INVALIDO' }, 400)
    try {
      const data = await oficinaService.putAsignaciones(id, c.req.valid('json'), c.get('user').id)
      return c.json(data)
    } catch (err: any) {
      if (err?.code === 'PERSONA_NO_EXISTE')    return c.json({ error: 'PERSONA_NO_EXISTE' }, 404)
      if (err?.code === 'SUMA_NO_100')          return c.json({ error: 'SUMA_NO_100' }, 400)
      if (err?.code === 'OBRA_COD_REQUERIDO')   return c.json({ error: 'OBRA_COD_REQUERIDO' }, 400)
      if (err?.code === 'OBRA_NO_EXISTE')       return c.json({ error: 'OBRA_NO_EXISTE' }, 400)
      if (err?.code === 'DESTINO_DUPLICADO')    return c.json({ error: 'DESTINO_DUPLICADO' }, 400)
      throw err
    }
  },
)

// ── Resumen mensual ──

oficina.get('/resumen', zValidator('query', ResumenQuerySchema), async (c) => {
  const { mes } = c.req.valid('query')
  const data = await oficinaService.getResumen(mes)
  return c.json(data)
})

export default oficina
