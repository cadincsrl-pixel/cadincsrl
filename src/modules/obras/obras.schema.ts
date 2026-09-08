import { z } from 'zod'

export const ObraSchema = z.object({
  cod: z.string(),
  nom: z.string(),
  cc: z.string().nullable(),
  dir: z.string().nullable(),
  resp: z.string().nullable(),
  obs: z.string().nullable(),
  archivada: z.boolean().default(false),
  fecha_archivo: z.string().nullable(),
})

// FK opcionales a profiles(id). Cuando se setean, el service
// auto-asigna la obra al user en `usuario_obras` con modulo=NULL.
const UserIdField = z.string().uuid().nullable().optional()

// El código se autogenera en el backend (RPC siguiente_codigo_obra).
// Cualquier `cod` enviado en el body se ignora — el zod no lo lista,
// así que zod hace strip silencioso si llega.
// Quién se hace cargo de los materiales (20260904ak). 'cliente': se cobran en
// la cuenta del cliente. 'cadinc': obra llave en mano, todo es gasto de CADINC.
// Un trigger de la base recalcula `a_cargo_de` de la cuenta al cambiarlo.
const ACargoDeField = z.enum(['cliente', 'cadinc']).optional()

export const CreateObraSchema = z.object({
  nom: z.string().min(1, 'El nombre es requerido'),
  cc: z.string().optional().default(''),
  dir: z.string().optional().default(''),
  resp: z.string().optional().default(''),
  obs: z.string().optional().default(''),
  capataz_user_id:   UserIdField,
  jefe_obra_user_id: UserIdField,
  materiales_a_cargo_de: ACargoDeField,
})

export const UpdateObraSchema = z.object({
  nom: z.string().min(1).optional(),
  cc: z.string().optional(),
  dir: z.string().optional(),
  resp: z.string().optional(),
  obs: z.string().optional(),
  capataz_user_id:   UserIdField,
  jefe_obra_user_id: UserIdField,
  materiales_a_cargo_de: ACargoDeField,
  // Prender/apagar la vista de administración. Los porcentajes NO van acá:
  // viven versionados en obras_admin_tarifas y tienen su propio endpoint.
  por_administracion: z.boolean().optional(),
})

/**
 * Una versión de porcentajes de una obra por administración. `desde` siempre
 * viernes (los costos de operarios y contratistas son semanales, así que el %
 * cambia en frontera de semana). Se agregan versiones, nunca se pisan.
 */
export const AdminTarifaSchema = z.object({
  desde:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pct_operarios:    z.number().min(0).max(500),
  pct_contratistas: z.number().min(0).max(500),
  pct_materiales:   z.number().min(0).max(500),
})
export type AdminTarifaDto = z.infer<typeof AdminTarifaSchema>

export type Obra = z.infer<typeof ObraSchema>
export type CreateObraDto = z.infer<typeof CreateObraSchema>
export type UpdateObraDto = z.infer<typeof UpdateObraSchema>