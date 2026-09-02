import { z } from 'zod'

export const ContratistasSchema = z.object({
  id: z.number(),
  nom: z.string(),
  especialidad: z.string().nullable(),
  tel: z.string().nullable(),
  obs: z.string().nullable(),
  razon_social: z.string().nullable(),
  cuit: z.string().nullable(),
  cuil: z.string().nullable(),
  dni: z.string().nullable(),
})

// El CBU argentino son 22 dígitos; se acepta con espacios/guiones y se limpia.
const CbuSchema = z
  .string()
  .transform(s => s.replace(/[\s-]/g, ''))
  .refine(s => s === '' || /^\d{22}$/.test(s), 'El CBU debe tener 22 dígitos')

export const CreateContratistaSchema = z.object({
  nom:          z.string().min(1, 'El nombre es requerido'),
  especialidad: z.string().nullable().optional(),
  tel:          z.string().nullable().optional(),
  obs:          z.string().nullable().optional(),
  razon_social: z.string().nullable().optional(),
  cuit:         z.string().nullable().optional(),
  cuil:         z.string().nullable().optional(),
  dni:          z.string().nullable().optional(),
  banco_cuenta:   z.string().nullable().optional(),
  cbu:            CbuSchema.nullable().optional(),
  alias_cbu:      z.string().nullable().optional(),
  titular_cuenta: z.string().nullable().optional(),
})

export const UpdateContratistaSchema = z.object({
  nom:          z.string().min(1).optional(),
  especialidad: z.string().nullable().optional(),
  tel:          z.string().nullable().optional(),
  obs:          z.string().nullable().optional(),
  razon_social: z.string().nullable().optional(),
  cuit:         z.string().nullable().optional(),
  cuil:         z.string().nullable().optional(),
  dni:          z.string().nullable().optional(),
  banco_cuenta:   z.string().nullable().optional(),
  cbu:            CbuSchema.nullable().optional(),
  alias_cbu:      z.string().nullable().optional(),
  titular_cuenta: z.string().nullable().optional(),
})

// ── Adjuntos (bucket privado contratista-docs) ──
// Flujo de 2 pasos (igual que vehiculo-docs / seguro-poliza). Lo comparten el
// DNI del contratista y el doc del presupuesto.
export const DocUploadUrlSchema = z.object({
  nombre_archivo: z.string().min(1),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

export const DocRegistrarSchema = z.object({
  storage_path:   z.string().min(1),
  nombre_archivo: z.string().min(1),
  mime_type:      z.string().min(1),
  size_bytes:     z.number().int().positive(),
})

// ── Asignaciones a obras ──
export const AsigContratistaSchema = z.object({
  obra_cod: z.string().min(1),
  contrat_id: z.number().int(),
})

// Finalizar / reactivar al contratista en la obra (asig_contrat.finalizado_en).
export const FinalizarAsigSchema = z.object({
  finalizado: z.boolean(),
})

// Formato + fecha real: '2026-02-31' pasa el regex pero PG la rechaza (22008 → 500).
const FechaSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
  .refine(s => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, 'Fecha inválida')

// sem_key = ISO del viernes de la semana CADINC (viernes → jueves). La DB lo
// exige con CHECK (cert_sem_key_viernes_chk); se valida acá para responder un
// 400 legible en vez de un 23514.
const SemKeySchema = FechaSchema.refine(
  s => new Date(`${s}T00:00:00Z`).getUTCDay() === 5,
  'sem_key debe ser el viernes de la semana',
)

// ── Presupuestos (contrat_presupuestos) ──
export const CreatePresupuestoSchema = z.object({
  obra_cod:   z.string().min(1),
  contrat_id: z.number().int(),
  titulo:     z.string().trim().min(1, 'El título es requerido'),
  monto:      z.number().positive('El monto debe ser mayor a 0'),
  fecha:      FechaSchema.optional(),
  obs:        z.string().nullable().optional(),
})

// cerrado: true → cerrado_en = now(); false → null (reabrir).
export const UpdatePresupuestoSchema = z.object({
  titulo:  z.string().trim().min(1, 'El título es requerido').optional(),
  monto:   z.number().positive('El monto debe ser mayor a 0').optional(),
  fecha:   FechaSchema.optional(),
  obs:     z.string().nullable().optional(),
  cerrado: z.boolean().optional(),
})

// ── Certificaciones ──
// Sin `estado`: el certificado se paga sí o sí el viernes de cobro. Los
// clientes viejos todavía lo mandan y z.object lo descarta (strip).
// presupuesto_id null/ausente = sin presupuesto (histórico); el service exige
// uno cuando el contratista tiene presupuestos abiertos en la obra.
export const CertificacionSchema = z.object({
  obra_cod:       z.string().min(1),
  contrat_id:     z.number().int(),
  sem_key:        SemKeySchema,
  monto:          z.number().min(0),
  desc:           z.string().optional().default(''),
  presupuesto_id: z.number().int().nullable().optional(),
})

export const UpdateCertificacionSchema = z.object({
  monto:          z.number().min(0).optional(),
  desc:           z.string().optional(),
  presupuesto_id: z.number().int().nullable().optional(),
})

export type Contratista = z.infer<typeof ContratistasSchema>
export type CreateContratistaDto = z.infer<typeof CreateContratistaSchema>
export type UpdateContratistaDto = z.infer<typeof UpdateContratistaSchema>
export type DocUploadUrlDto = z.infer<typeof DocUploadUrlSchema>
export type DocRegistrarDto = z.infer<typeof DocRegistrarSchema>
export type AsigContratistaDto = z.infer<typeof AsigContratistaSchema>
export type FinalizarAsigDto = z.infer<typeof FinalizarAsigSchema>
export type CreatePresupuestoDto = z.infer<typeof CreatePresupuestoSchema>
export type UpdatePresupuestoDto = z.infer<typeof UpdatePresupuestoSchema>
export type CertificacionDto = z.infer<typeof CertificacionSchema>
export type UpdateCertificacionDto = z.infer<typeof UpdateCertificacionSchema>
