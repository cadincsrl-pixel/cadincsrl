import { z } from 'zod'
import { esViernes, hoyArgentinaISO } from '../../lib/semanas.js'

/** Deja solo dígitos: "36.890.735" → "36890735". Vacío si no hay ninguno. */
export function normalizarDni(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

/** DNI argentino: 7 u 8 dígitos. Vacío = no cargado (se admite). */
export function dniValido(dniNormalizado: string): boolean {
  return dniNormalizado === '' || /^\d{7,8}$/.test(dniNormalizado)
}

/**
 * Nacimiento plausible para alguien que trabaja: entre 100 y 14 años antes de
 * `hoyISO`. Corta los typos de año que ya entraron en prod (2022 por 2002,
 * 1193 por 1993).
 */
export function fechaNacimientoValida(iso: string, hoyISO: string): boolean {
  const anio = Number(hoyISO.slice(0, 4))
  const resto = hoyISO.slice(4)
  return iso >= `${anio - 100}${resto}` && iso <= `${anio - 14}${resto}`
}

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/

// Se guarda normalizado (solo dígitos) para que el control de duplicados
// compare peras con peras: "36.890.735" y "36890735" son el mismo DNI.
const DniSchema = z.string().max(20).nullable()
  .transform(normalizarDni)
  .refine(dniValido, 'DNI inválido: tiene que tener 7 u 8 dígitos')

const FechaNacimientoSchema = z.string().regex(ISO_FECHA, 'Fecha inválida')
  .refine(f => fechaNacimientoValida(f, hoyArgentinaISO()), 'Fecha de nacimiento inválida: revisá el año')

const ViernesSchema = z.string().regex(ISO_FECHA, 'Fecha inválida')
  .refine(esViernes, 'La fecha tiene que ser un viernes (inicio de la semana)')

const TalleSchema = z.string().trim().max(20).nullable().optional()

export const PersonalSchema = z.object({
  leg: z.string(),
  nom: z.string(),
  dni: z.string().nullable(),
  cat_id: z.number(),
  tel: z.string().nullable(),
  dir: z.string().nullable(),
  obs: z.string().nullable(),
})

export const CreatePersonalSchema = z.object({
  leg:              z.string().trim().min(1, 'El legajo es requerido').max(20),
  nom:              z.string().trim().min(1, 'El nombre es requerido').max(120),
  dni:              DniSchema.optional().default(''),
  condicion:        z.enum(['blanco', 'asegurado']).nullable().optional(),
  modalidad:        z.enum(['hora', 'mes']).optional().default('hora'),
  cat_id:           z.number({ error: 'La categoría es requerida' }).int().positive('La categoría es requerida'),
  tel:              z.string().trim().max(60).optional().default(''),
  dir:              z.string().trim().max(200).optional().default(''),
  obs:              z.string().trim().max(1000).optional().default(''),
  talle_pantalon:   TalleSchema,
  talle_botines:    TalleSchema,
  talle_camisa:     TalleSchema,
  fecha_nacimiento: FechaNacimientoSchema.nullable().optional(),
})

export const UpdatePersonalSchema = z.object({
  nom:              z.string().trim().min(1, 'El nombre es requerido').max(120).optional(),
  dni:              DniSchema.optional(),
  condicion:        z.enum(['blanco', 'asegurado']).nullable().optional(),
  modalidad:        z.enum(['hora', 'mes']).optional(),
  cat_id:           z.number().int().positive().optional(),
  // Viernes desde el que rige la categoría nueva. Default: la semana en curso.
  // Solo se mira si `cat_id` cambia respecto del valor actual.
  cat_desde:        ViernesSchema.optional(),
  // Un cambio de categoría con `cat_desde` en el pasado recalcula semanas ya
  // cerradas: el backend responde 409 salvo que venga esta confirmación.
  confirmar_historico: z.boolean().optional(),
  tel:              z.string().trim().max(60).optional(),
  dir:              z.string().trim().max(200).optional(),
  obs:              z.string().trim().max(1000).optional(),
  talle_pantalon:   TalleSchema,
  talle_botines:    TalleSchema,
  talle_camisa:     TalleSchema,
  activo_override:  z.boolean().nullable().optional(),
  fecha_nacimiento: FechaNacimientoSchema.nullable().optional(),
})

export type Personal = z.infer<typeof PersonalSchema>
export type CreatePersonalDto = z.infer<typeof CreatePersonalSchema>
export type UpdatePersonalDto = z.infer<typeof UpdatePersonalSchema>
