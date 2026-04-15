import { z } from 'zod'

export const CreateMaterialSchema = z.object({
  obra_cod:       z.string(),
  fecha:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descripcion:    z.string().min(1),
  proveedor:      z.string().optional().default(''),
  cantidad:       z.number().min(0),
  unidad:         z.string().optional().default('unid'),
  precio_unit:    z.number().min(0),
  obs:            z.string().optional().default(''),
  adjunto_url:    z.string().optional().default(''),
  adjunto_nombre: z.string().optional().default(''),
  compra_id:      z.string().optional().default(''),
})

export const UpdateMaterialSchema = CreateMaterialSchema.partial().omit({ obra_cod: true })

export const CreateAdicionalSchema = z.object({
  obra_cod:       z.string(),
  fecha:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descripcion:    z.string().min(1),
  monto:          z.number().min(0),
  adjunto_url:    z.string().optional().default(''),
  adjunto_nombre: z.string().optional().default(''),
  obs:            z.string().optional().default(''),
})

export const UpdateAdicionalSchema = CreateAdicionalSchema.partial().omit({ obra_cod: true })

export type CreateMaterialDto   = z.infer<typeof CreateMaterialSchema>
export type UpdateMaterialDto   = z.infer<typeof UpdateMaterialSchema>
export type CreateAdicionalDto  = z.infer<typeof CreateAdicionalSchema>
export type UpdateAdicionalDto  = z.infer<typeof UpdateAdicionalSchema>
