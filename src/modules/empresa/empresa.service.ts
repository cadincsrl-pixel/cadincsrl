/**
 * Datos de la empresa (tanda 6, 20260929a). La escritura pasa SIEMPRE por la
 * RPC `empresa_guardar`, que vuelve a chequear `admin.configurar` y rechaza el
 * CUIT (lo define el certificado de ARCA).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { conSistema, empresaDesdeJson, getEmpresa, invalidarEmpresa, type EmpresaConSistema } from '../../lib/empresa.js'

export class EmpresaHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code)
    this.name = 'EmpresaHttpError'
  }
}

const STATUS: Readonly<Record<string, number>> = {
  EMPRESA_INVALIDA: 400, CUIT_NO_EDITABLE: 400, USUARIO_REQUERIDO: 400,
  SIN_PERMISO: 403, EMPRESA_SIN_FILA: 500,
}

const Txt = (max: number, min = 0) => z.string().trim().min(min).max(max)

/** Parcial de los campos editables. Sin `cuit` (strict: viene → 400). */
export const EmpresaPatchSchema = z.object({
  razon_social:       Txt(120, 3).optional(),
  nombre_fantasia:    Txt(80, 2).optional(),
  condicion_iva:      Txt(60, 3).optional(),
  iibb:               Txt(30).optional(),
  inicio_actividades: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  domicilio_calle:    Txt(120).optional(),
  calle_factura:      Txt(120).optional(),
  localidad:          Txt(80).optional(),
  provincia:          Txt(60).optional(),
  codigo_postal:      Txt(10).optional(),
  telefono:           Txt(40).optional(),
  email:              z.union([z.literal(''), z.string().trim().email().max(120)]).optional(),
}).strict()
export type EmpresaPatch = z.infer<typeof EmpresaPatchSchema>

function parseDetail(d: unknown): unknown {
  if (d == null || d === '') return undefined
  if (typeof d !== 'string') return d
  try { return JSON.parse(d) } catch { return d }
}

export const empresaService = {
  async obtener(db?: SupabaseClient): Promise<EmpresaConSistema> {
    return conSistema(await getEmpresa(db))
  },

  async guardar(db: SupabaseClient, cambios: EmpresaPatch, userId: string): Promise<EmpresaConSistema> {
    const { data, error } = await db.rpc('empresa_guardar', { p_cambios: cambios, p_user_id: userId })
    if (error) {
      const code = (error.message || '').match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/)?.[1]
      if (code && STATUS[code] !== undefined) throw new EmpresaHttpError(STATUS[code]!, code, parseDetail(error.details))
      throw new EmpresaHttpError(500, 'DB_ERROR', { dbMessage: error.message })
    }
    invalidarEmpresa()
    return conSistema(empresaDesdeJson(data))
  },
}
