import { z } from 'zod'

// Fecha en formato ISO (YYYY-MM-DD), igual que el resto del backend.
const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD')
// Hora en formato HH:MM o HH:MM:SS (la columna es `time`).
const HoraSQL = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Formato requerido: HH:MM')

// ── Enums (espejan los CHECK constraints del schema en Supabase) ──
export const TipoMaquinaEnum = z.enum([
  'cargadora_frontal',
  'retroexcavadora',
  'retropala',
  'excavadora',
  'miniexcavadora',
  'minicargadora',
  'motoniveladora',
  'topadora',
  'compactador',
  'pavimentadora',
  'manipulador_telescopico',
  'hidrogrua',
  'grua',
  'camion_volcador',
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
  seguro:         z.string().nullable().optional(),
  seguro_vence:   FechaISO.nullable().optional(),
  estado:         EstadoMaquinaEnum.default('activa'),
  obs:            z.string().nullable().optional(),
})

// Update: NO usar .partial() sobre el create — arrastra los .default() y zod
// inyecta defaults en un PATCH parcial, pisando datos válidos en la DB.
export const UpdateMaquinaSchema = z.object({
  nombre:         z.string().min(1).optional(),
  tipo:           TipoMaquinaEnum.optional(),
  identificacion: z.string().nullable().optional(),
  seguro:         z.string().nullable().optional(),
  seguro_vence:   FechaISO.nullable().optional(),
  estado:         EstadoMaquinaEnum.optional(),
  obs:            z.string().nullable().optional(),
})

// ── Póliza de seguro (archivo adjunto en bucket alquiler-docs) ──
// Flujo de 2 pasos (igual que vehiculo-docs): pedir signed upload URL,
// el cliente sube el archivo, y se registra el storage_path en la máquina.
export const SeguroUploadUrlSchema = z.object({
  nombre_archivo: z.string().min(1),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

export const SeguroRegistrarSchema = z.object({
  storage_path:   z.string().min(1),
  nombre_archivo: z.string().min(1),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
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
  // maquinista = trabajador del listado de personal (FK a personal.leg).
  maquinista_leg:     z.string().nullable().optional(),
  // legacy: maquinista como usuario del sistema (Fase 3). Se mantiene opcional.
  maquinista_user_id: z.string().uuid().nullable().optional(),
})

// Solo se puede cambiar el maquinista. El par (obra, máquina) es la identidad
// de la asignación (UNIQUE); para reasignar la máquina a otra obra se borra y
// se crea una nueva.
export const UpdateObraMaquinaSchema = z.object({
  maquinista_leg:     z.string().nullable().optional(),
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

// ── Remitos (Fase 2) ──────────────────────────────────────────
// Listado de remitos emitidos. Todos los filtros son opcionales (la pestaña
// Remitos puede mostrar todos). El rango filtra por fecha_trabajo.
export const ListRemitosQuerySchema = z.object({
  obra_id:    z.coerce.number().int().positive().optional(),
  maquina_id: z.coerce.number().int().positive().optional(),
  desde:      FechaISO.optional(),
  hasta:      FechaISO.optional(),
})

// ── Reportes (Fase 3) ─────────────────────────────────────────
// Horas por máquina: filtros opcionales (obra + rango por fecha de parte).
export const ReporteHorasQuerySchema = z.object({
  obra_id:    z.coerce.number().int().positive().optional(),
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
export type ListRemitosQuery      = z.infer<typeof ListRemitosQuerySchema>
export type ReporteHorasQuery     = z.infer<typeof ReporteHorasQuerySchema>
export type SeguroUploadUrlDto    = z.infer<typeof SeguroUploadUrlSchema>
export type SeguroRegistrarDto    = z.infer<typeof SeguroRegistrarSchema>
