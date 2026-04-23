import { z } from 'zod'
import { TipoCombustibleEnum } from './gastos.schema.js'

const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD')

// ── Listado de cargas ────────────────────────────────────────────
export const ListCargasQuerySchema = z.object({
  camion_id:        z.coerce.number().int().positive().optional(),
  chofer_id:        z.coerce.number().int().positive().optional(),
  tipo_combustible: TipoCombustibleEnum.optional(),
  tanque_lleno:     z.coerce.boolean().optional(),
  desde:            FechaISO.optional(),
  hasta:            FechaISO.optional(),
  limit:            z.coerce.number().int().min(1).max(500).default(100),
  offset:           z.coerce.number().int().min(0).default(0),
})

// ── Rango de fechas para reportes ────────────────────────────────
export const ReporteRangoSchema = z.object({
  desde: FechaISO,
  hasta: FechaISO,
}).refine(d => d.desde <= d.hasta, {
  message: 'desde debe ser <= hasta',
  path:    ['desde'],
})

// ── Consumo por camión ───────────────────────────────────────────
export const ConsumoCamionQuerySchema = z.object({
  camion_id: z.coerce.number().int().positive(),
  desde:     FechaISO,
  hasta:     FechaISO,
}).refine(d => d.desde <= d.hasta, {
  message: 'desde debe ser <= hasta',
  path:    ['desde'],
})

// ── Consumo por chofer/mes ───────────────────────────────────────
export const ConsumoChoferMesQuerySchema = z.object({
  desde:     FechaISO,
  hasta:     FechaISO,
  chofer_id: z.coerce.number().int().positive().optional(),
}).refine(d => d.desde <= d.hasta, {
  message: 'desde debe ser <= hasta',
  path:    ['desde'],
})

// ── Ranking ──────────────────────────────────────────────────────
export const RankingChoferesQuerySchema = z.object({
  desde: FechaISO,
  hasta: FechaISO,
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Evita ranking injusto de choferes con pocas cargas.
  min_cargas: z.coerce.number().int().min(1).max(20).default(3),
}).refine(d => d.desde <= d.hasta, {
  message: 'desde debe ser <= hasta',
  path:    ['desde'],
})

export type ListCargasQuery           = z.infer<typeof ListCargasQuerySchema>
export type ConsumoCamionQuery        = z.infer<typeof ConsumoCamionQuerySchema>
export type ConsumoChoferMesQuery     = z.infer<typeof ConsumoChoferMesQuerySchema>
export type RankingChoferesQuery      = z.infer<typeof RankingChoferesQuerySchema>
