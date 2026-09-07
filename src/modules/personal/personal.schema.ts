import { z } from 'zod'
import { esViernes, hoyArgentinaISO } from '../../lib/semanas.js'

// ── Reglas de campos del legajo ─────────────────────────────────────────────
// Espejo exacto en el frontend: src/lib/utils/personal.ts. Si cambia una regla,
// cambia en los dos repos (y en el CHECK de la base si lo hay).

/** Legajo: 3 dígitos con padding ("099", "112"); 4 cuando pasen de 999. */
export const LEGAJO_RE = /^\d{3,4}$/

/** Deja solo dígitos: "36.890.735" → "36890735". Vacío si no hay ninguno. */
export function normalizarDni(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

/** DNI argentino: 7 u 8 dígitos (se admiten puntos y espacios). Vacío = no cargado (solo legajos viejos). */
export function dniValido(dni: string | null | undefined): boolean {
  const crudo = (dni ?? '').trim()
  return crudo === '' || /^\d{7,8}$/.test(normalizarDni(crudo))
}

/** Deja solo dígitos: "381-555-1234" → "3815551234". */
export function normalizarTelefono(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

/**
 * Celular argentino sin 0 ni 15: 10 dígitos (se admiten guiones, espacios y
 * paréntesis). Se toleran 8 a 13 por fijos viejos. Vacío = sin cargar. Texto
 * sin dígitos ("sin teléfono") NO vale: se rechaza, no se vacía en silencio.
 */
export function telefonoValido(tel: string | null | undefined): boolean {
  const crudo = (tel ?? '').trim()
  return crudo === '' || /^\d{8,13}$/.test(normalizarTelefono(crudo))
}

/** Recorta y deja un solo espacio entre palabras. */
export function normalizarNombre(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ')
}

/** Apellido y nombre: al menos dos palabras, solo letras (con acentos), punto, coma, apóstrofo o guion. */
export function nombreValido(nombreNormalizado: string): boolean {
  const palabras = nombreNormalizado.split(/[\s,]+/).filter(Boolean)
  return palabras.length >= 2 && palabras.every(p => /^[\p{L}][\p{L}.'’-]*$/u.test(p))
}

export function normalizarTalle(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase()
}

/** Talle: número de dos dígitos entre 30 y 60 (pantalón/camisa 40–56, botines 39–44 hoy) o XS…XXXL. */
export function talleValido(talleNormalizado: string): boolean {
  if (talleNormalizado === '') return true
  if (/^\d{2}$/.test(talleNormalizado)) {
    const n = Number(talleNormalizado)
    return n >= 30 && n <= 60
  }
  return /^(XS|S|M|L|XL|XXL|XXXL)$/.test(talleNormalizado)
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

export const MSG = {
  legajo:     'El legajo son 3 dígitos, ej. 112',
  nombre:     'Apellido y nombre: al menos dos palabras y solo letras',
  dni:        'DNI inválido: tiene que tener 7 u 8 dígitos',
  dniFalta:   'El DNI es obligatorio',
  telefono:   'Teléfono inválido: 10 dígitos sin 0 ni 15, ej. 3815551234',
  talle:      'Talle inválido: número (ej. 44) o S, M, L, XL',
  nacimiento: 'Fecha de nacimiento inválida: revisá el año',
  viernes:    'La fecha tiene que ser un viernes (inicio de la semana)',
} as const

// Todo se guarda normalizado (DNI y teléfono solo dígitos, nombre sin espacios
// dobles, talle en mayúsculas) para que el control de duplicados y las búsquedas
// comparen peras con peras. Los `.optional()` van AFUERA de estos schemas: así
// un campo ausente en el PATCH sigue ausente y no se pisa con ''.
const DniSchema      = z.string().max(20).nullable().refine(dniValido, MSG.dni).transform(normalizarDni)
const TelefonoSchema = z.string().max(30).nullable().refine(telefonoValido, MSG.telefono).transform(normalizarTelefono)
const NombreSchema   = z.string().max(120).transform(normalizarNombre).refine(nombreValido, MSG.nombre)
const TalleSchema    = z.string().max(10).nullable().transform(normalizarTalle).refine(talleValido, MSG.talle)
const LegajoSchema   = z.string().trim().regex(LEGAJO_RE, MSG.legajo)

const FechaNacimientoSchema = z.iso.date('Fecha inválida')
  .refine(f => fechaNacimientoValida(f, hoyArgentinaISO()), MSG.nacimiento)

const ViernesSchema = z.iso.date('Fecha inválida')
  .refine(esViernes, MSG.viernes)

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
  leg:              LegajoSchema,
  nom:              NombreSchema,
  // Obligatorio al crear (pedido del user 2026-09-06): es lo único que evita
  // cargar dos veces a la misma persona. Hay índice único parcial en la base.
  dni:              z.string({ error: MSG.dniFalta }).max(20)
                      .refine(dniValido, MSG.dni)
                      .transform(normalizarDni)
                      .refine(d => d !== '', MSG.dniFalta),
  condicion:        z.enum(['blanco', 'asegurado']).nullable().optional(),
  modalidad:        z.enum(['hora', 'mes']).optional().default('hora'),
  cat_id:           z.number({ error: 'La categoría es requerida' }).int().positive('La categoría es requerida'),
  tel:              TelefonoSchema.optional().default(''),
  dir:              z.string().trim().max(200).optional().default(''),
  obs:              z.string().trim().max(1000).optional().default(''),
  talle_pantalon:   TalleSchema.optional(),
  talle_botines:    TalleSchema.optional(),
  talle_camisa:     TalleSchema.optional(),
  fecha_nacimiento: FechaNacimientoSchema.nullable().optional(),
})

export const UpdatePersonalSchema = z.object({
  nom:              NombreSchema.optional(),
  // '' solo se acepta si el legajo nunca tuvo DNI (lo controla el service).
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
  tel:              TelefonoSchema.optional(),
  dir:              z.string().trim().max(200).optional(),
  obs:              z.string().trim().max(1000).optional(),
  talle_pantalon:   TalleSchema.optional(),
  talle_botines:    TalleSchema.optional(),
  talle_camisa:     TalleSchema.optional(),
  activo_override:  z.boolean().nullable().optional(),
  fecha_nacimiento: FechaNacimientoSchema.nullable().optional(),
})

export type Personal = z.infer<typeof PersonalSchema>
export type CreatePersonalDto = z.infer<typeof CreatePersonalSchema>
export type UpdatePersonalDto = z.infer<typeof UpdatePersonalSchema>
