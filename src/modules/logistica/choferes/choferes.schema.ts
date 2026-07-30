import { z } from 'zod'

export const CreateChoferSchema = z.object({
  nombre:    z.string().min(1, 'El nombre es requerido'),
  cuil:      z.string().optional().default(''),
  tel:       z.string().optional().default(''),
  licencia:  z.string().optional().default(''),
  alias:     z.string().optional().default(''),
  cbu:       z.string().optional().default(''),
  estado:    z.enum(['activo', 'descanso', 'inactivo']).default('activo'),
  camion_id: z.number().nullable().optional(),
  batea_id:  z.number().nullable().optional(),
  basico_dia:        z.number().optional().default(0),
  precio_km_cargado: z.number().optional().default(0),
  precio_km_vacio:   z.number().optional().default(0),
  // false = fletero externo, no está en la nómina de CADINC. Excluido de
  // Gastos > Reportes.
  es_propio:         z.boolean().optional().default(true),
  // km_jornal = básico + km (default). pct = % de la facturación neta de sus
  // viajes + jornal opcional (basico_dia; 0 = solo %).
  modalidad_pago:    z.enum(['km_jornal', 'pct']).optional().default('km_jornal'),
  obs:               z.string().optional().default(''),
})

// Update: NO usar .partial() sobre el create porque arrastra los .default('')
// y zod inyecta valores vacíos cuando el cliente manda un PATCH parcial,
// pisando datos válidos en la DB (bug que vació cuiles/tel/licencia/obs).
export const UpdateChoferSchema = z.object({
  nombre:    z.string().min(1).optional(),
  cuil:      z.string().optional(),
  tel:       z.string().optional(),
  licencia:  z.string().optional(),
  alias:     z.string().optional(),
  cbu:       z.string().optional(),
  estado:    z.enum(['activo', 'descanso', 'inactivo']).optional(),
  camion_id: z.number().nullable().optional(),
  batea_id:  z.number().nullable().optional(),
  // basico_dia / precio_km_cargado / precio_km_vacio NO se editan por acá: son
  // cache de la última versión del historial. Cambiarlos in-place re-valuaba
  // retroactivamente todo el trabajo sin liquidar (mismo bug que tarja el
  // 2026-06-26). Van por PATCH /choferes/:id/tarifas, que pide "vigente desde"
  // y guarda una versión. Migración 20260729g.
  es_propio:         z.boolean().optional(),
  modalidad_pago:    z.enum(['km_jornal', 'pct']).optional(),
  obs:               z.string().optional(),
})

// Alta de una versión de tarifas vigente desde una fecha.
export const SetTarifasChoferSchema = z.object({
  desde:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
  basico_dia:        z.number().min(0).optional(),
  precio_km_cargado: z.number().min(0).optional(),
  precio_km_vacio:   z.number().min(0).optional(),
  // % de facturación (modalidad pct), versionado igual que el resto.
  pct_facturacion:   z.number().min(0).max(100).optional(),
}).refine(
  d => d.basico_dia != null || d.precio_km_cargado != null || d.precio_km_vacio != null || d.pct_facturacion != null,
  { message: 'Mandá al menos una tarifa' },
)

// Traspaso de unidades entre choferes: el origen entrega su camión y/o batea
// al destino en una sola operación. Con `intercambio`, el origen recibe a su
// vez las unidades que tenía el destino (swap); sin él, quedan sin asignar.
export const TraspasoChoferSchema = z.object({
  origen_id:   z.number(),
  destino_id:  z.number(),
  camion:      z.boolean().default(true),
  batea:       z.boolean().default(true),
  intercambio: z.boolean().default(false),
})
  .refine(d => d.origen_id !== d.destino_id, { message: 'El origen y el destino deben ser choferes distintos' })
  .refine(d => d.camion || d.batea, { message: 'Hay que traspasar al menos camión o batea' })

export type CreateChoferDto   = z.infer<typeof CreateChoferSchema>
export type UpdateChoferDto   = z.infer<typeof UpdateChoferSchema>
export type TraspasoChoferDto = z.infer<typeof TraspasoChoferSchema>
export type SetTarifasChoferDto = z.infer<typeof SetTarifasChoferSchema>