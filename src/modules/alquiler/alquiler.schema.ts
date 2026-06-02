import { z } from 'zod'

// Fecha en formato ISO (YYYY-MM-DD), igual que el resto del backend.
const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD')
// Hora en formato HH:MM o HH:MM:SS (la columna es `time`).
const HoraSQL = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Formato requerido: HH:MM')

// ── Enums (espejan los CHECK constraints del schema en Supabase) ──
export const TipoMaquinaEnum = z.enum([
  'hidrogrua',
  'retropala',
  'minicargadora',
  'trailer_canasta',
  'otro',
])
export const EstadoMaquinaEnum = z.enum(['activa', 'mantenimiento', 'inactiva'])
export const EstadoObraEnum    = z.enum(['activa', 'cerrada'])

// ── Máquinas ──────────────────────────────────────────────────
export const CreateMaquinaSchema = z.object({
  nombre:         z.string().min(1, 'El nombre es requerido'),
  tipo:           TipoMaquinaEnum.default('otro'),
  identificacion: z.string().nullable().optional(),
  estado:         EstadoMaquinaEnum.default('activa'),
  obs:            z.string().nullable().optional(),
})

// Update: NO usar .partial() sobre el create — arrastra los .default() y zod
// inyecta defaults en un PATCH parcial, pisando datos válidos en la DB.
export const UpdateMaquinaSchema = z.object({
  nombre:         z.string().min(1).optional(),
  tipo:           TipoMaquinaEnum.optional(),
  identificacion: z.string().nullable().optional(),
  estado:         EstadoMaquinaEnum.optional(),
  obs:            z.string().nullable().optional(),
})

// ── Obras ─────────────────────────────────────────────────────
export const CreateObraSchema = z.object({
  nombre:            z.string().min(1, 'El nombre es requerido'),
  cliente:           z.string().nullable().optional(),
  ubicacion:         z.string().nullable().optional(),
  descripcion:       z.string().nullable().optional(),
  jefe_obra_user_id: z.string().uuid().nullable().optional(),
  estado:            EstadoObraEnum.default('activa'),
  fecha_inicio:      FechaISO.nullable().optional(),
  obs:               z.string().nullable().optional(),
})

export const UpdateObraSchema = z.object({
  nombre:            z.string().min(1).optional(),
  cliente:           z.string().nullable().optional(),
  ubicacion:         z.string().nullable().optional(),
  descripcion:       z.string().nullable().optional(),
  jefe_obra_user_id: z.string().uuid().nullable().optional(),
  estado:            EstadoObraEnum.optional(),
  fecha_inicio:      FechaISO.nullable().optional(),
  obs:               z.string().nullable().optional(),
})

// ── Asignación máquina ↔ obra ─────────────────────────────────
export const CreateObraMaquinaSchema = z.object({
  maquina_id:         z.number().int().positive(),
  maquinista_user_id: z.string().uuid().nullable().optional(),
})

// Solo se puede cambiar el maquinista. El par (obra, máquina) es la identidad
// de la asignación (UNIQUE); para reasignar la máquina a otra obra se borra y
// se crea una nueva.
export const UpdateObraMaquinaSchema = z.object({
  maquinista_user_id: z.string().uuid().nullable().optional(),
})

// ── Partes ────────────────────────────────────────────────────
export const CreateParteSchema = z.object({
  obra_id:        z.number().int().positive(),
  maquina_id:     z.number().int().positive(),
  fecha:          FechaISO,
  manana_entrada: HoraSQL.nullable().optional(),
  manana_salida:  HoraSQL.nullable().optional(),
  tarde_entrada:  HoraSQL.nullable().optional(),
  tarde_salida:   HoraSQL.nullable().optional(),
  horas:          z.number().nonnegative().nullable().optional(),
  detalle:        z.string().nullable().optional(),
  obs:            z.string().nullable().optional(),
})

// El par (obra, máquina, fecha) es la identidad del parte (UNIQUE); no se
// permite moverlo por PATCH. Se cambian horarios / horas / detalle / obs.
export const UpdateParteSchema = z.object({
  manana_entrada: HoraSQL.nullable().optional(),
  manana_salida:  HoraSQL.nullable().optional(),
  tarde_entrada:  HoraSQL.nullable().optional(),
  tarde_salida:   HoraSQL.nullable().optional(),
  horas:          z.number().nonnegative().nullable().optional(),
  detalle:        z.string().nullable().optional(),
  obs:            z.string().nullable().optional(),
})

// Filtro de listado de partes: obra obligatoria + rango de fechas opcional +
// máquina opcional.
export const ListPartesQuerySchema = z.object({
  obra_id:    z.coerce.number().int().positive(),
  maquina_id: z.coerce.number().int().positive().optional(),
  desde:      FechaISO.optional(),
  hasta:      FechaISO.optional(),
})

export type CreateMaquinaDto      = z.infer<typeof CreateMaquinaSchema>
export type UpdateMaquinaDto      = z.infer<typeof UpdateMaquinaSchema>
export type CreateObraDto         = z.infer<typeof CreateObraSchema>
export type UpdateObraDto         = z.infer<typeof UpdateObraSchema>
export type CreateObraMaquinaDto  = z.infer<typeof CreateObraMaquinaSchema>
export type UpdateObraMaquinaDto  = z.infer<typeof UpdateObraMaquinaSchema>
export type CreateParteDto        = z.infer<typeof CreateParteSchema>
export type UpdateParteDto        = z.infer<typeof UpdateParteSchema>
export type ListPartesQuery       = z.infer<typeof ListPartesQuerySchema>
