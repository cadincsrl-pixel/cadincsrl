/**
 * Importador de «Mis Comprobantes — Recibidos» de ARCA (20260927b/c).
 *
 * Todo lo de negocio lo decide `pagos_importar_recibidos` (molde de
 * `ventas_importar_externos`): tipo soportado, duplicados contra lo cargado a
 * mano, proveedor por CUIT (lo crea si no existe), desglose, período IVA =
 * mes de la fecha. Con `confirmar=false` es VISTA PREVIA y no escribe nada;
 * con `true` es TODO O NADA (422 IMPORTACION_CON_ERRORES si alguna fila
 * falla). Con `periodo_iva` (20260928g) las filas de ese mes o anteriores
 * entran con ese período IVA. Las facturas entran impagas, `sin_imputar` (sin concepto ni reparto
 * por obra) y no se pueden aprobar hasta imputarlas. Con `historica`
 * (20260928) son de meses ya pagados: `pago_a_reconstruir`, fuera de la deuda.
 *
 * Entrada: `filas` ya normalizadas (contrato de la spec), o el archivo crudo
 * (`csv` o `matriz`) que se parsea acá con `arca-recibidos.ts`. En ese caso
 * los errores de lectura (fecha ilegible, sin número…) vuelven en
 * `errores_parseo` y cada fila de la respuesta lleva su `fila_archivo`.
 */
import { supabase } from '../../lib/supabase.js'
import { todasLasFilas } from '../../lib/paginar.js'
import { PagosHttpError, mapRpcError } from './pagos.errors.js'
import { FilaRecibidaSchema, type FilaRecibidaDto, type ImportarRecibidosDto } from './pagos.schema.js'
import { leerFilasRecibidos, csvAMatriz, filaParaRpc, type ErrorParseoRecibidos } from './arca-recibidos.js'

const MAX_FILAS = 2000
const cent = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** Importes a centavos (la base es numeric(14,2)): nada de 0,1 + 0,2. */
export function redondearFila(f: FilaRecibidaDto): FilaRecibidaDto {
  return {
    ...f,
    neto_gravado: cent(f.neto_gravado), no_gravado: cent(f.no_gravado), exento: cent(f.exento),
    otros_tributos: cent(f.otros_tributos), iva: cent(f.iva), total: cent(f.total),
    alicuotas: f.alicuotas == null ? null : f.alicuotas.map((a) => ({ alicuota_id: a.alicuota_id, base_imp: cent(a.base_imp), importe: cent(a.importe) })),
  }
}

/** Filas a mandar + errores de lectura + a qué fila del archivo corresponde cada una. */
export function prepararFilas(dto: ImportarRecibidosDto): {
  filas: FilaRecibidaDto[]; filaArchivo: number[] | null; errores: ErrorParseoRecibidos[]; formato: string | null
} {
  if (dto.filas) return { filas: dto.filas.map(redondearFila), filaArchivo: null, errores: [], formato: null }
  const r = leerFilasRecibidos(dto.csv !== undefined ? csvAMatriz(dto.csv) : (dto.matriz ?? []))
  if (r.error_archivo) throw new PagosHttpError(400, 'ARCHIVO_ILEGIBLE', { campo: 'archivo', motivo: r.error_archivo })
  const filas: FilaRecibidaDto[] = []
  const filaArchivo: number[] = []
  const errores = [...r.errores]
  for (const f of r.filas) {
    // Lo mismo que valida el body cuando las filas vienen armadas.
    const ok = FilaRecibidaSchema.safeParse(filaParaRpc(f))
    if (!ok.success) {
      const i = ok.error.issues[0]
      errores.push({ fila_archivo: f.fila_archivo, motivo: `Dato inválido en ${i?.path.join('.') || 'la fila'}: ${i?.message ?? ''}` })
      continue
    }
    filas.push(redondearFila(ok.data))
    filaArchivo.push(f.fila_archivo)
  }
  errores.sort((a, b) => a.fila_archivo - b.fila_archivo)
  return { filas, filaArchivo, errores, formato: r.formato }
}

export const importarArcaService = {
  async importar(dto: ImportarRecibidosDto, userId: string): Promise<Record<string, unknown>> {
    const { filas, filaArchivo, errores, formato } = prepararFilas(dto)
    if (filas.length === 0) throw new PagosHttpError(400, 'SIN_FILAS', { campo: 'filas', errores_parseo: errores })
    if (filas.length > MAX_FILAS) throw new PagosHttpError(400, 'DEMASIADAS_FILAS', { max: MAX_FILAS, filas: filas.length })
    // Todo o nada también con lo que no se pudo ni leer.
    if (dto.confirmar && errores.length > 0) {
      throw new PagosHttpError(422, 'IMPORTACION_CON_ERRORES', { errores_parseo: errores })
    }
    const { data, error } = await supabase.rpc('pagos_importar_recibidos', {
      p_filas: filas, p_user_id: userId, p_confirmar: dto.confirmar,
      p_archivo: dto.archivo ?? '', p_hash: dto.hash_sha256 ?? null,
      p_historica: dto.historica ?? false,
      p_periodo_iva: dto.periodo_iva ?? null,
    })
    if (error) throw mapRpcError(error)
    const r = (data ?? {}) as Record<string, unknown>
    console.info(`[pagos] importar ARCA recibidos ${dto.confirmar ? 'CONFIRMADO' : 'vista previa'}${dto.historica ? ' (histórica)' : ''}${dto.periodo_iva ? ` (período IVA ${dto.periodo_iva.slice(0, 7)})` : ''} «${dto.archivo ?? ''}» por ${userId}: `
      + `${String(r.total_filas)} filas, ${String(r.nuevas)} nuevas, ${String(r.duplicadas)} duplicadas, ${String(r.errores)} con error, `
      + `${Array.isArray(r.proveedores_nuevos) ? r.proveedores_nuevos.length : 0} proveedores nuevos`
      + (r.importacion_id != null ? ` (importación ${String(r.importacion_id)})` : ''))
    if (!filaArchivo) return r
    // El índice de la RPC es la posición en `p_filas` (1-based, como en ventas).
    const out: Record<string, unknown> = { ...r, formato, errores_parseo: errores }
    if (Array.isArray(r.filas)) {
      out.filas = (r.filas as Record<string, unknown>[]).map((f, pos) => {
        const idx = typeof f.indice === 'number' ? f.indice : pos + 1
        return { ...f, fila_archivo: filaArchivo[idx - 1] ?? filaArchivo[pos] ?? null }
      })
    }
    return out
  },

  /**
   * Historial de importaciones (más nueva primero), con quién la hizo, si se
   * deshizo (20260929k) y cuántas de sus facturas siguen vigentes.
   */
  async listar(): Promise<unknown[]> {
    const filas = await todasLasFilas<Record<string, unknown>>((d, h) => supabase.from('pagos_importaciones')
      .select('id, origen, archivo, hash_sha256, fecha_desde, fecha_hasta, filas, nuevas, duplicadas, proveedores_nuevos, historica, created_at, created_by, deshecha_at, deshecha_por, motivo_deshacer')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(d, h))
    const ids = [...new Set(filas.flatMap((f) => [f.created_by, f.deshecha_por]).filter((x): x is string => typeof x === 'string'))]
    const nombres = new Map<string, string>()
    if (ids.length) {
      const { data } = await supabase.from('profiles').select('id, nombre').in('id', ids)
      for (const p of (data ?? []) as { id: string; nombre: string | null }[]) nombres.set(p.id, p.nombre ?? '')
    }
    // Conteo por importación con head (sin bajar filas: el cap de 1000 no aplica).
    const vigentes = await Promise.all(filas.map(async (f) => {
      const { count, error } = await supabase.from('pagos_facturas').select('id', { count: 'exact', head: true })
        .eq('importacion_id', f.id as number).neq('estado', 'anulada')
      return error ? null : (count ?? 0)
    }))
    const nombre = (u: unknown) => (typeof u === 'string' ? (nombres.get(u) ?? null) : null)
    return filas.map((f, i) => ({
      ...f,
      created_by_nombre: nombre(f.created_by),
      deshecha_por_nombre: nombre(f.deshecha_por),
      facturas_vigentes: vigentes[i],
    }))
  },

  /**
   * Vista previa de deshacer una importación (20260929k): cuántas facturas se
   * anulan, cuántos asientos del motor y qué la bloquea. No escribe nada.
   */
  async deshacerVista(importacionId: number, userId: string): Promise<DeshacerImportacionRes> {
    const { data, error } = await supabase.rpc('pagos_deshacer_importacion', {
      p_importacion_id: importacionId, p_motivo: null, p_user_id: userId, p_aplicar: false,
    })
    if (error) throw mapRpcError(error)
    return data as DeshacerImportacionRes
  },

  /**
   * Deshace una importación: TODO O NADA. Anula sus facturas y los asientos
   * del motor en períodos abiertos, en una sola transacción. 409
   * IMPORTACION_CON_MOVIMIENTOS { bloqueos } si alguna tiene pago, NC,
   * imputación, aprobación o asiento en un período cerrado.
   */
  async deshacer(importacionId: number, motivo: string, userId: string): Promise<DeshacerImportacionRes> {
    const { data, error } = await supabase.rpc('pagos_deshacer_importacion', {
      p_importacion_id: importacionId, p_motivo: motivo, p_user_id: userId, p_aplicar: true,
    })
    if (error) throw mapRpcError(error)
    const r = data as DeshacerImportacionRes
    console.info(`[pagos] importación ${importacionId} DESHECHA por ${userId}: ${r.a_anular} facturas anuladas, ${r.asientos_a_anular} asientos anulados`)
    return r
  },
}

export interface BloqueoDeshacer {
  factura_id: number
  numero: string | null
  tipo_comprobante: string | null
  proveedor: string | null
  motivo: 'con_pago' | 'con_nc' | 'imputada' | 'aprobada' | 'asiento_periodo_cerrado'
}

export interface DeshacerImportacionRes {
  importacion: { id: number; archivo: string | null; created_at: string; historica: boolean; filas: number }
  total: number
  a_anular: number
  ya_anuladas: number
  asientos_a_anular: number
  bloqueos: BloqueoDeshacer[]
  puede: boolean
  aplicado: boolean
}
