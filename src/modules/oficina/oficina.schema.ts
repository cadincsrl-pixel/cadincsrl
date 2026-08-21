import { z } from 'zod'

// Oficina = personal administrativo (no operarios de tarja). Sus sueldos se
// versionan por `desde` (mismo patrón que categoria_tarifas) y se distribuyen
// en porcentajes contra obras / logística / general (snapshots por `desde`).

const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const MesSchema = z.string().regex(/^\d{4}-\d{2}$/)

export const CreatePersonaSchema = z.object({
  nombre:        z.string().min(1).max(200),
  costo_mensual: z.number().min(0),
  // Default en el service: hoy.
  desde:         FechaSchema.optional(),
})

export const UpdatePersonaSchema = z.object({
  nombre: z.string().min(1).max(200).optional(),
  activo: z.boolean().optional(),
})

export const CreateSueldoSchema = z.object({
  costo_mensual: z.number().min(0),
  desde:         FechaSchema,
})

const AsignacionItemSchema = z.object({
  destino:    z.enum(['obra', 'logistica', 'general']),
  obra_cod:   z.string().min(1).nullable().optional(),
  porcentaje: z.number().gt(0).max(100),
})

// Códigos de negocio que el superRefine emite como `message`. Las routes los
// mapean a 400 { error: CODE } vía el hook del zValidator; el service los
// re-valida como backstop (la existencia de obra_cod en `obras` va solo en
// el service porque necesita DB).
export const ASIGNACIONES_ERROR_CODES = [
  'SUMA_NO_100',
  'OBRA_COD_REQUERIDO',
  'DESTINO_DUPLICADO',
] as const

export const PutAsignacionesSchema = z
  .object({
    desde: FechaSchema,
    items: z.array(AsignacionItemSchema).min(1),
  })
  .superRefine((val, ctx) => {
    const suma = val.items.reduce((s, i) => s + i.porcentaje, 0)
    if (Math.abs(suma - 100) > 0.01) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'SUMA_NO_100' })
    }
    const seen = new Set<string>()
    val.items.forEach((it, idx) => {
      const tieneObra = it.obra_cod != null && it.obra_cod !== ''
      // Espejo del CHECK de la tabla: (destino='obra') = (obra_cod is not null)
      if ((it.destino === 'obra') !== tieneObra) {
        ctx.addIssue({ code: 'custom', path: ['items', idx, 'obra_cod'], message: 'OBRA_COD_REQUERIDO' })
      }
      const key = `${it.destino}|${tieneObra ? it.obra_cod : ''}`
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['items', idx], message: 'DESTINO_DUPLICADO' })
      }
      seen.add(key)
    })
  })

// Aumento masivo: genera una versión nueva de sueldo por persona a partir de
// la vigente ANTERIOR a `desde` (base estricta < desde: re-aplicar con el
// mismo desde corrige la versión en vez de componer sobre ella). El % puede
// ser distinto por persona; negativo = rebaja.
export const AplicarAumentoSchema = z.object({
  desde: FechaSchema,
  items: z.array(z.object({
    persona_id: z.number().int().positive(),
    porcentaje: z.number().gt(-100).max(1000),
  })).min(1),
})

export const ResumenQuerySchema = z.object({
  mes: MesSchema,
})

export type CreatePersonaDto   = z.infer<typeof CreatePersonaSchema>
export type UpdatePersonaDto   = z.infer<typeof UpdatePersonaSchema>
export type CreateSueldoDto    = z.infer<typeof CreateSueldoSchema>
export type PutAsignacionesDto = z.infer<typeof PutAsignacionesSchema>
export type AsignacionItemDto  = z.infer<typeof AsignacionItemSchema>
export type AplicarAumentoDto  = z.infer<typeof AplicarAumentoSchema>
