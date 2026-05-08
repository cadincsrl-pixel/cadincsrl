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
export const CreateObraSchema = z.object({
  nom: z.string().min(1, 'El nombre es requerido'),
  cc: z.string().optional().default(''),
  dir: z.string().optional().default(''),
  resp: z.string().optional().default(''),
  obs: z.string().optional().default(''),
  capataz_user_id:   UserIdField,
  jefe_obra_user_id: UserIdField,
})

export const UpdateObraSchema = z.object({
  nom: z.string().min(1).optional(),
  cc: z.string().optional(),
  dir: z.string().optional(),
  resp: z.string().optional(),
  obs: z.string().optional(),
  capataz_user_id:   UserIdField,
  jefe_obra_user_id: UserIdField,
})

export type Obra = z.infer<typeof ObraSchema>
export type CreateObraDto = z.infer<typeof CreateObraSchema>
export type UpdateObraDto = z.infer<typeof UpdateObraSchema>