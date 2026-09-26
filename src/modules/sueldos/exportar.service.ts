/**
 * Junta lo que necesitan las exportaciones (liquidación con líneas + legajos
 * con CUIL/CBU) y llama a los armadores puros de `exportar.ts`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CUIT_EMPRESA } from '../../lib/empresa.js'
import { rpc, n, enmascarar } from './comun.js'
import { SueldosHttpError } from './sueldos.errors.js'
import { legajosService } from './legajos.service.js'
import { exportarBanco, resumenContador, generarLsd, generarConceptosLsd, type ConceptoLsd, type EmpleadoExport, type LiquidacionExport, type LineaExport } from './exportar.js'
import { fechaDeValores } from './calculo.js'

type Fila = Record<string, unknown>

async function cargar(liqId: number, db: SupabaseClient): Promise<{ liq: LiquidacionExport; empleados: EmpleadoExport[] }> {
  const j = await rpc<Fila | null>(db, 'sueldos_liquidacion_json', { p_id: liqId, p_con_lineas: true })
  if (!j) throw new SueldosHttpError(404, 'LIQUIDACION_NO_EXISTE', { id: liqId })
  const recibos = (Array.isArray(j.recibos) ? j.recibos : []) as Fila[]
  const legajos = await legajosService.crudos(recibos.map(r => Number(r.legajo_id)), db)
  const porId = new Map(legajos.map(l => [Number(l.id), l]))
  const conv = (j.convenio ?? {}) as Fila
  const liq: LiquidacionExport = {
    id: Number(j.id), codigo: String(j.codigo), numero: Number(j.numero), tipo: j.tipo as LiquidacionExport['tipo'],
    periodo: String(j.periodo).slice(0, 10), quincena: j.quincena == null ? null : (Number(j.quincena) as 1 | 2),
    fecha_pago: (j.fecha_pago as string | null) ?? null, estado: String(j.estado),
    convenio: { codigo: String(conv.codigo ?? ''), nombre: String(conv.nombre ?? '') },
  }
  const empleados: EmpleadoExport[] = recibos
    .filter(r => r.estado !== 'anulado')
    .map(r => {
      const l = porId.get(Number(r.legajo_id)) ?? {}
      const lineas = ((Array.isArray(r.lineas) ? r.lineas : []) as Fila[]).map((x): LineaExport => ({
        concepto_id: x.concepto_id == null ? null : Number(x.concepto_id),
        codigo_arca: (x.codigo_arca as string | null) ?? null,
        nombre: String(x.nombre), tipo: x.tipo as LineaExport['tipo'],
        destino: (x.destino as string | null) ?? null, grupo_contribucion: (x.grupo_contribucion as string | null) ?? null,
        cantidad: x.cantidad == null ? null : n(x.cantidad), unidad: (x.unidad as string | null) ?? null, importe: n(x.importe),
      }))
      return {
        legajo_id: Number(r.legajo_id),
        leg: (l.leg as string | null) ?? null,
        nombre: String(l.nombre_mostrar ?? (r.legajo as Fila | undefined)?.nombre ?? ''),
        cuil: (l.cuil as string | null) ?? null,
        cbu: (l.cbu as string | null) ?? null,
        categoria: (l.categoria_nombre as string | null) ?? null,
        obra_social_codigo: (l.obra_social_codigo as string | null) || null,
        conyuge_a_cargo: l.conyuge_a_cargo === true,
        hijos_a_cargo: n(l.hijos_a_cargo),
        modalidad_contratacion: (l.modalidad_contratacion as string | null) ?? null,
        dias_trabajados: r.dias_trabajados == null ? null : n(r.dias_trabajados),
        horas_trabajadas: r.horas_trabajadas == null ? null : n(r.horas_trabajadas),
        total_remunerativo: n(r.total_remunerativo), total_no_remunerativo: n(r.total_no_remunerativo),
        total_descuentos: n(r.total_descuentos), neto: n(r.neto), total_contribuciones: n(r.total_contribuciones),
        fondo_cese: n(r.fondo_cese), lineas,
      }
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
  return { liq, empleados }
}

export const exportarService = {
  async banco(liqId: number, decimal: 'coma' | 'punto' | undefined, db: SupabaseClient) {
    const { liq, empleados } = await cargar(liqId, db)
    // Se paga lo cerrado: un borrador puede cambiar después de transferir.
    if (liq.estado !== 'cerrada') throw new SueldosHttpError(409, 'LIQUIDACION_NO_CERRADA', { id: liq.id, estado: liq.estado })
    return exportarBanco(liq, empleados, { decimal })
  },

  /** Resumen para el contador. Sin `ver_pii` el CUIL sale enmascarado. */
  async resumen(liqId: number, verPii: boolean, db: SupabaseClient) {
    const { liq, empleados } = await cargar(liqId, db)
    const r = resumenContador(liq, empleados)
    return { ...r, empleados: r.empleados.map(e => ({ ...e, cuil: enmascarar(e.cuil, verPii) })) }
  },

  async lsd(liqId: number, db: SupabaseClient) {
    const { liq, empleados } = await cargar(liqId, db)
    const fecha = fechaDeValores({ tipo: liq.tipo, periodo: liq.periodo, quincena: liq.quincena })
    const det = await rpc<number | null>(db, 'sueldos_valor_parametro', { p_clave: 'detraccion_por_empleado', p_fecha: fecha })
    const factor = liq.tipo === 'mensual' ? 1 : liq.tipo === 'quincena' ? 0.5 : 0
    return generarLsd({ cuit: CUIT_EMPRESA, liquidacion: liq, empleados, detraccion: n(det) * factor })
  },

  /** TXT para dar de alta en el LSD los conceptos del empleador con su concepto ARCA. */
  async lsdConceptos(db: SupabaseClient) {
    const { data, error } = await db.from('sueldos_conceptos')
      .select('id, codigo_arca, nombre, tipo, convenio:sueldos_convenios(nombre)')
      .eq('activo', true).neq('tipo', 'contribucion').order('id')
    if (error) throw error
    const conceptos: ConceptoLsd[] = (data ?? []).map((c: Fila) => {
      const conv = (Array.isArray(c.convenio) ? c.convenio[0] : c.convenio) as Fila | null
      return {
        id: Number(c.id), codigo_arca: (c.codigo_arca as string | null) ?? null, tipo: c.tipo as ConceptoLsd['tipo'],
        nombre: conv?.nombre ? `${String(c.nombre)} (${String(conv.nombre)})` : String(c.nombre),
      }
    })
    return generarConceptosLsd(conceptos)
  },
}
