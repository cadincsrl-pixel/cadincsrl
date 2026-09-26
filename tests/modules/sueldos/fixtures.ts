/**
 * Valores vigentes a sep-2026 armados con los seeds de 20261004e (lo que
 * devolvería `sueldos_valores_a_fecha`), para probar el motor sin base.
 */
import type { ConceptoMotor, ValoresAFecha, ValorConcepto, LegajoMotor } from '../../../src/modules/sueldos/calculo.js'

let nextId = 1
const val = (porcentaje: number | null, monto: number | null, a_confirmar = false, origen: 'concepto' | 'parametro' = 'concepto'): ValorConcepto =>
  ({ origen, parametro_clave: null, porcentaje, monto, vigente_desde: '2026-01-01', a_confirmar, fuente: 'test' })

type C = Partial<ConceptoMotor> & Pick<ConceptoMotor, 'codigo' | 'tipo' | 'calculo'>
function concepto(c: C): ConceptoMotor {
  return {
    id: nextId++, convenio_id: null, nombre: c.codigo, base: null, condicion: 'siempre', codigo_arca: null,
    grupo_contribucion: null, destino: c.tipo === 'descuento' || c.tipo === 'contribucion' ? 'f931' : null,
    parametro_clave: null, unidad: null, en_recibo: true, orden: 0, automatico: true, activo: true, valor: null, ...c,
  }
}

function comunes(): ConceptoMotor[] {
  return [
    concepto({ codigo: 'basico', tipo: 'remunerativo', calculo: 'cantidad_x_escala', codigo_arca: '110000', orden: 10 }),
    concepto({ codigo: 'horas_extra_50', tipo: 'remunerativo', calculo: 'cantidad_x_escala', codigo_arca: '130001', unidad: 'horas', orden: 20, automatico: false, valor: val(150, null) }),
    concepto({ codigo: 'horas_extra_100', tipo: 'remunerativo', calculo: 'cantidad_x_escala', codigo_arca: '130002', unidad: 'horas', orden: 21, automatico: false, valor: val(200, null) }),
    concepto({ codigo: 'sac', tipo: 'remunerativo', calculo: 'manual', codigo_arca: '120001', orden: 40, automatico: false }),
    concepto({ codigo: 'vacaciones', tipo: 'remunerativo', calculo: 'manual', unidad: 'dias', orden: 42, automatico: false }),
    concepto({ codigo: 'indemnizacion', tipo: 'no_remunerativo', calculo: 'manual', orden: 44, automatico: false }),
    concepto({ codigo: 'adicional_manual', tipo: 'remunerativo', calculo: 'manual', orden: 50, automatico: false }),
    concepto({ codigo: 'jubilacion', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', codigo_arca: '810001', unidad: '%', orden: 60, valor: val(11, null) }),
    concepto({ codigo: 'ley_19032', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', codigo_arca: '810002', unidad: '%', orden: 61, excluye_jubilados: true, valor: val(3, null) }),
    concepto({ codigo: 'obra_social', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', codigo_arca: '810003', unidad: '%', orden: 62, excluye_jubilados: true, valor: val(3, null) }),
    concepto({ codigo: 'prestamo', tipo: 'descuento', calculo: 'manual', codigo_arca: '810007', destino: 'prestamo', orden: 70, automatico: false }),
    concepto({ codigo: 'otro_descuento', tipo: 'descuento', calculo: 'manual', destino: 'otros', orden: 71, automatico: false }),
    concepto({ codigo: 'contrib_ss', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', condicion: 'no_rifl', grupo_contribucion: 'seguridad_social', parametro_clave: 'contrib_patronal_pct', unidad: '%', orden: 80, excluye_jubilados: true, valor: val(18, null, false, 'parametro') }),
    concepto({ codigo: 'contrib_ss_jubilado', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', grupo_contribucion: 'seguridad_social', parametro_clave: 'contrib_patronal_jubilado_pct', unidad: '%', orden: 80, solo_jubilados: true, valor: val(10.77, null, false, 'parametro') }),
    concepto({ codigo: 'contrib_rifl', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', condicion: 'rifl', grupo_contribucion: 'seguridad_social', parametro_clave: 'rifl_pct', unidad: '%', orden: 81, valor: val(5, null, false, 'parametro') }),
    concepto({ codigo: 'contrib_os', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', grupo_contribucion: 'obra_social', unidad: '%', orden: 82, excluye_jubilados: true, valor: val(6, null) }),
    concepto({ codigo: 'art', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', grupo_contribucion: 'art', parametro_clave: 'art_pct', unidad: '%', orden: 83, valor: val(0, null, true, 'parametro') }),
    concepto({ codigo: 'art_fijo', tipo: 'contribucion', calculo: 'monto_fijo', grupo_contribucion: 'art', parametro_clave: 'art_fijo', unidad: '$', orden: 84, valor: val(null, 0, true, 'parametro') }),
    concepto({ codigo: 'scvo', tipo: 'contribucion', calculo: 'monto_fijo', grupo_contribucion: 'otros', parametro_clave: 'scvo_monto', unidad: '$', orden: 85, valor: val(null, 424.62, false, 'parametro') }),
  ]
}

const parametros = {
  detraccion_por_empleado: { valor: 7003.68, vigente_desde: '2026-01-01', a_confirmar: false, fuente: '' },
  contrib_patronal_pct: { valor: 18, vigente_desde: '2026-01-01', a_confirmar: false, fuente: '' },
  horas_mes_uocra: { valor: 190.67, vigente_desde: '2026-01-01', a_confirmar: false, fuente: '' },
  horas_dia_uocra: { valor: 9, vigente_desde: '2026-01-01', a_confirmar: true, fuente: '' },
  divisor_vacaciones: { valor: 25, vigente_desde: '2026-01-01', a_confirmar: false, fuente: '' },
  dias_mes: { valor: 30, vigente_desde: '2026-01-01', a_confirmar: false, fuente: '' },
}

export function valoresUocra(fecha = '2026-09-30'): ValoresAFecha {
  const base = comunes()
  const propios: ConceptoMotor[] = [
    concepto({ codigo: 'asistencia', tipo: 'remunerativo', calculo: 'porcentaje', base: 'basico', codigo_arca: '170001', unidad: '%', orden: 30, valor: val(20, null) }),
    concepto({ codigo: 'adicional_tarea', tipo: 'remunerativo', calculo: 'porcentaje', base: 'basico', unidad: '%', orden: 31, automatico: false, valor: val(10, null, true) }),
    concepto({ codigo: 'cuota_sindical', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', condicion: 'afiliado', destino: 'sindicato', unidad: '%', orden: 63, valor: val(2.5, null, true) }),
    concepto({ codigo: 'aporte_solidario', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', condicion: 'no_afiliado', destino: 'sindicato', unidad: '%', orden: 64, valor: val(2, null) }),
    concepto({ codigo: 'seguro_vida', tipo: 'descuento', calculo: 'porcentaje', base: 'sereno_zona_a', destino: 'sindicato', unidad: '%', orden: 65, valor: val(2, null, true) }),
    concepto({ codigo: 'contrib_especial', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', grupo_contribucion: 'sindical', destino: 'sindicato', unidad: '%', orden: 86, valor: val(2, null) }),
    concepto({ codigo: 'ieric', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', grupo_contribucion: 'otros', destino: 'otros', unidad: '%', orden: 87, valor: null }),
    concepto({ codigo: 'fondo_cese_1', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', condicion: 'antiguedad_menor_1', grupo_contribucion: 'otros', destino: 'fondo_cese', unidad: '%', orden: 90, valor: val(12, null) }),
    concepto({ codigo: 'fondo_cese_2', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', condicion: 'antiguedad_mayor_igual_1', grupo_contribucion: 'otros', destino: 'fondo_cese', unidad: '%', orden: 91, valor: val(8, null) }),
  ]
  return {
    fecha, zona: 'A',
    convenio: { id: 1, codigo: 'uocra', nombre: 'UOCRA', periodicidad: 'quincenal', unidad_basico: 'hora' },
    categorias: [
      { id: 11, codigo: 'oficial', nombre: 'Oficial', orden: 2, unidad_basico: 'hora', por_defecto: false, activo: true, valor: 6468, vigente_desde: '2026-09-01', a_confirmar: true, fuente: '' },
      { id: 12, codigo: 'ayudante', nombre: 'Ayudante', orden: 4, unidad_basico: 'hora', por_defecto: true, activo: true, valor: 5502, vigente_desde: '2026-09-01', a_confirmar: true, fuente: '' },
      { id: 13, codigo: 'sereno', nombre: 'Sereno', orden: 5, unidad_basico: 'mes', por_defecto: false, activo: true, valor: 999495, vigente_desde: '2026-09-01', a_confirmar: true, fuente: '' },
      { id: 14, codigo: 'sin_escala', nombre: 'Sin escala', orden: 6, unidad_basico: 'hora', por_defecto: false, activo: true, valor: null, vigente_desde: null, a_confirmar: null, fuente: null },
    ],
    conceptos: [...base, ...propios],
    parametros: { ...parametros },
    sereno_zona_a: 999495,
  }
}

export function valoresUecara(fecha = '2026-09-30'): ValoresAFecha {
  const propios: ConceptoMotor[] = [
    concepto({ codigo: 'antiguedad', tipo: 'remunerativo', calculo: 'por_unidad', codigo_arca: '160001', unidad: 'anios', orden: 32, valor: val(null, 13844) }),
    concepto({ codigo: 'titulo_a', tipo: 'remunerativo', calculo: 'monto_fijo', unidad: '$', orden: 33, valor: val(null, 75742, true) }),
    concepto({ codigo: 'titulo_b', tipo: 'remunerativo', calculo: 'monto_fijo', unidad: '$', orden: 33, valor: null }),
    concepto({ codigo: 'titulo_c', tipo: 'remunerativo', calculo: 'monto_fijo', unidad: '$', orden: 33, valor: val(null, 51732, true) }),
    concepto({ codigo: 'falla_caja', tipo: 'remunerativo', calculo: 'monto_fijo', unidad: '$', orden: 34, automatico: false, valor: val(null, 73143) }),
    concepto({ codigo: 'presentismo', tipo: 'remunerativo', calculo: 'porcentaje', base: 'basico', codigo_arca: '170001', unidad: '%', orden: 35, valor: val(10, null, true) }),
    concepto({ codigo: 'cuota_sindical', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', condicion: 'afiliado', destino: 'sindicato', unidad: '%', orden: 63, valor: null }),
    concepto({ codigo: 'fal', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', grupo_contribucion: 'otros', destino: 'otros', parametro_clave: 'fal_pct', unidad: '%', orden: 89, valor: null }),
  ]
  return {
    fecha, zona: 'A',
    convenio: { id: 2, codigo: 'uecara', nombre: 'UECARA', periodicidad: 'mensual', unidad_basico: 'mes' },
    categorias: [
      { id: 21, codigo: 'aux_adm_g2', nombre: 'Auxiliar administrativo (Grupo II)', orden: 1, unidad_basico: 'mes', por_defecto: true, activo: true, valor: 1624878, vigente_desde: '2026-09-01', a_confirmar: true, fuente: '' },
    ],
    conceptos: [...comunes(), ...propios],
    parametros: { ...parametros },
    sereno_zona_a: 999495,
  }
}

export function valoresCamioneros(fecha = '2026-09-30'): ValoresAFecha {
  const propios: ConceptoMotor[] = [
    concepto({ codigo: 'antiguedad', tipo: 'remunerativo', calculo: 'porcentaje', base: 'basico', codigo_arca: '160001', unidad: 'anios', orden: 32, valor: val(1, null, true) }),
    concepto({ codigo: 'km_remunerativo', tipo: 'remunerativo', calculo: 'por_unidad', unidad: 'km', orden: 36, automatico: false, valor: val(null, 80.09, true) }),
    concepto({ codigo: 'viatico_km', tipo: 'no_remunerativo', calculo: 'por_unidad', unidad: 'km', orden: 37, automatico: false, valor: val(null, 80.09, true) }),
    concepto({ codigo: 'viatico_comida', tipo: 'no_remunerativo', calculo: 'por_unidad', unidad: 'unidades', orden: 38, automatico: false, valor: val(null, 16463, true) }),
    concepto({ codigo: 'pernocte', tipo: 'no_remunerativo', calculo: 'por_unidad', unidad: 'unidades', orden: 39, automatico: false, valor: val(null, 19175, true) }),
    concepto({ codigo: 'suma_acuerdo', tipo: 'no_remunerativo', calculo: 'monto_fijo', unidad: '$', orden: 45, valor: val(null, 18000) }),
    concepto({ codigo: 'cuota_sindical', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', destino: 'sindicato', unidad: '%', orden: 63, valor: val(3, null) }),
    concepto({ codigo: 'sepelio', tipo: 'descuento', calculo: 'porcentaje', base: 'remunerativo', destino: 'sindicato', unidad: '%', orden: 66, valor: val(1.5, null, true) }),
    concepto({ codigo: 'oschoca', tipo: 'contribucion', calculo: 'monto_fijo', grupo_contribucion: 'obra_social', destino: 'sindicato', unidad: '$', orden: 92, valor: val(null, 29000) }),
    concepto({ codigo: 'fal', tipo: 'contribucion', calculo: 'porcentaje', base: 'remunerativo', grupo_contribucion: 'otros', destino: 'otros', parametro_clave: 'fal_pct', unidad: '%', orden: 89, valor: null }),
  ]
  return {
    fecha, zona: 'A',
    convenio: { id: 3, codigo: 'camioneros', nombre: 'Camioneros', periodicidad: 'mensual', unidad_basico: 'mes' },
    categorias: [
      { id: 31, codigo: 'conductor_1', nombre: 'Conductor 1ª', orden: 1, unidad_basico: 'mes', por_defecto: false, activo: true, valor: 1095276.83, vigente_desde: '2026-09-01', a_confirmar: false, fuente: '' },
    ],
    conceptos: [...comunes(), ...propios],
    parametros: { ...parametros },
    sereno_zona_a: 999495,
  }
}

export function legajo(p: Partial<LegajoMotor> = {}): LegajoMotor {
  return {
    id: 1, categoria_id: 11, zona: 'A', fecha_ingreso: '2026-03-01', fecha_egreso: null,
    afiliado_sindicato: true, rifl: false, titulo_nivel: null, ...p,
  }
}
