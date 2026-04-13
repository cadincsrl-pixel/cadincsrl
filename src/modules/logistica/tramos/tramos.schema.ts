import { z } from 'zod'

export const CreateTramoSchema = z.object({
  chofer_id:   z.number(),
  camion_id:   z.number(),
  tipo:        z.enum(['cargado', 'vacio']).default('cargado'),
  cantera_id:  z.number().nullable().optional(),
  deposito_id: z.number().nullable().optional(),

  // Carga (tipo='cargado')
  fecha_carga:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toneladas_carga:    z.number().optional(),
  remito_carga:       z.string().optional().default(''),

  // Descarga (se registra después via PATCH)
  fecha_descarga:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toneladas_descarga: z.number().optional(),
  remito_descarga:    z.string().optional().default(''),

  // Vacío
  fecha_vacio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  obs: z.string().optional().default(''),
})

export const UpdateTramoSchema = CreateTramoSchema.partial().extend({
  estado: z.enum(['en_curso', 'completado']).optional(),
})

export const RegistrarDescargaSchema = z.object({
  fecha_descarga:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toneladas_descarga: z.number().optional(),
  remito_descarga:    z.string().optional().default(''),
})

export type CreateTramoDto       = z.infer<typeof CreateTramoSchema>
export type UpdateTramoDto       = z.infer<typeof UpdateTramoSchema>
export type RegistrarDescargaDto = z.infer<typeof RegistrarDescargaSchema>
