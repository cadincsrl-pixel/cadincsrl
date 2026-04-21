import { z } from 'zod'

export const CreateTramoSchema = z.object({
  chofer_id:   z.number(),
  camion_id:   z.number(),
  tipo:        z.enum(['cargado', 'vacio']).default('cargado'),
  cantera_id:  z.number().nullable().optional(),
  deposito_id: z.number().nullable().optional(),

  // Carga (tipo='cargado')
  fecha_carga:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toneladas_carga:      z.number().optional(),
  remito_carga:         z.string().optional().default(''),
  remito_carga_img_url: z.string().url().nullable().optional(),

  // Descarga (se registra después via PATCH)
  fecha_descarga:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toneladas_descarga:      z.number().optional(),
  remito_descarga:         z.string().optional().default(''),
  remito_descarga_img_url: z.string().url().nullable().optional(),

  // Vacío
  fecha_vacio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  empresa_id: z.number().nullable().optional(),
  obs: z.string().optional().default(''),
})

export const UpdateTramoSchema = z.object({
  chofer_id:          z.number().optional(),
  camion_id:          z.number().optional(),
  tipo:               z.enum(['cargado', 'vacio']).optional(),
  cantera_id:         z.number().nullable().optional(),
  deposito_id:        z.number().nullable().optional(),
  empresa_id:         z.number().nullable().optional(),
  fecha_carga:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toneladas_carga:         z.number().optional(),
  remito_carga:            z.string().optional(),
  remito_carga_img_url:    z.string().url().nullable().optional(),
  fecha_descarga:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toneladas_descarga:      z.number().optional(),
  remito_descarga:         z.string().optional(),
  remito_descarga_img_url: z.string().url().nullable().optional(),
  fecha_vacio:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  obs:                z.string().optional(),
  estado:             z.enum(['en_curso', 'completado']).optional(),
})

export const RegistrarDescargaSchema = z.object({
  fecha_descarga:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toneladas_descarga:      z.number().optional(),
  remito_descarga:         z.string().optional().default(''),
  remito_descarga_img_url: z.string().url().nullable().optional(),
})

export type CreateTramoDto       = z.infer<typeof CreateTramoSchema>
export type UpdateTramoDto       = z.infer<typeof UpdateTramoSchema>
export type RegistrarDescargaDto = z.infer<typeof RegistrarDescargaSchema>
