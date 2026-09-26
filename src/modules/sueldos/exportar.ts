/**
 * Exportaciones de una liquidación (TS puro, testeable):
 *   - banco: CSV de acreditación (CUIL; nombre; CBU; importe);
 *   - resumen para el contador / F.931: por empleado y por concepto con código ARCA;
 *   - LSD: TXT del Libro de Sueldos Digital de ARCA (registros 01–04).
 *
 * LSD — diseño de registro tomado de la planilla oficial de ARCA
 * «LSD-ARMADO-TXT-Liquidaciones.xlsx» (fórmulas de armado, versión 09/2025) y de la
 * Guía 15 «Interfaz de liquidación». Copia en ~/Desktop/CADINC-documentos/ARCA/LSD.
 *   01 (35):  "01" · CUIT(11) · "SJ" · período AAAAMM(6) · tipo M|Q(1) · nº de liquidación(5) ·
 *             días base "30"(2) · cantidad de registros 04(6).
 *   02 (115): "02" · CUIL(11) · legajo(10, izq.) · dependencia(50) · CBU(22, der.) ·
 *             días para proporcionar tope(3, "000" = no proporciona) · fecha de pago AAAAMMDD(8) ·
 *             fecha de rúbrica(8 blancos) · forma de pago 1 efectivo|2 cheque|3 acreditación(1).
 *   03 (51):  "03" · CUIL(11) · código de concepto DEL EMPLEADOR(10, izq.) · cantidad(5, 999,99) ·
 *             unidades $|%|A|Q|M|D|H|blanco(1) · importe(15, 2 dec.) · D|C(1) · período de ajuste(6).
 *   04 (370): "04" · CUIL · cónyuge(1) · hijos(2) · CCT(1) · SCVO(1) · reducción(1) · tipo empresa(1) ·
 *             tipo de operación "0" · situación(2) · condición(2) · actividad(3) · modalidad(3) ·
 *             siniestrado(2) · localidad(2) · 3 × (situación de revista(2) + día de inicio(2)) ·
 *             días trabajados(2) · horas trabajadas(3) (uno de los dos en 0) · % aporte adicional(5) ·
 *             contribución tarea diferencial(5) · obra social(6) · adherentes(2) · 20 importes de 15:
 *             aporte adic. OS, contrib. adic. OS, base dif. aportes OS/FSR, base dif. OS/FSR, base dif. LRT,
 *             remuneración maternidad, remuneración bruta, bases imponibles 1–9, base dif. aporte SS,
 *             base dif. contribución SS, base imponible 10 (= rem. − detracción), importe a detraer.
 * Lo que sigue A CONFIRMAR con el contador y el archivo lo avisa: códigos del F.931 (actividad,
 * condición, localidad…) y las bases imponibles, que se informan iguales a la remuneración
 * sin aplicar el tope de ANSES.
 * El registro 05 (empresas de servicios eventuales) no aplica a CADINC; el 06 es optativo.
 * Código de concepto del empleador (reg. 03): "C" + id del concepto. Antes de presentar el primer
 * archivo hay que dar de alta esos códigos en el LSD asociados a su concepto ARCA: lo hace
 * `generarConceptosLsd` (TXT de «carga masiva de conceptos» de ARCA, 195 posiciones).
 * Las contribuciones patronales no van en el 03 (las calcula el F.931).
 */
import { r2 } from './calculo.js'

export interface LineaExport {
  concepto_id: number | null
  codigo_arca: string | null
  nombre: string
  tipo: 'remunerativo' | 'no_remunerativo' | 'descuento' | 'contribucion'
  destino: string | null
  grupo_contribucion: string | null
  cantidad: number | null
  unidad: string | null
  importe: number
}

export interface EmpleadoExport {
  legajo_id: number
  leg: string | null
  nombre: string
  cuil: string | null
  cbu: string | null
  categoria: string | null
  obra_social_codigo: string | null
  conyuge_a_cargo: boolean
  hijos_a_cargo: number
  modalidad_contratacion: string | null
  /** Códigos del F.931 del legajo (o los del convenio). Null = los por defecto. */
  f931_condicion?: string | null
  f931_actividad?: string | null
  f931_modalidad?: string | null
  jubilado?: boolean
  dias_trabajados: number | null
  horas_trabajadas: number | null
  total_remunerativo: number
  total_no_remunerativo: number
  total_descuentos: number
  neto: number
  total_contribuciones: number
  fondo_cese: number
  lineas: LineaExport[]
}

export interface LiquidacionExport {
  id: number
  codigo: string
  numero: number
  tipo: 'quincena' | 'mensual' | 'sac' | 'vacaciones' | 'final' | 'ajuste'
  periodo: string
  quincena: 1 | 2 | null
  fecha_pago: string | null
  estado: string
  convenio: { codigo: string; nombre: string }
}

export interface AvisoExport {
  codigo: string
  legajo_id?: number
  nombre?: string
  detalle?: Record<string, unknown>
}

const sd = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '')

// ── Banco ───────────────────────────────────────────────────────────────────

export interface FilaBanco { legajo_id: number; cuil: string; nombre: string; cbu: string; importe: number }

export function exportarBanco(liq: LiquidacionExport, empleados: EmpleadoExport[], opts: { decimal?: 'coma' | 'punto' } = {}) {
  const avisos: AvisoExport[] = []
  const filasB: FilaBanco[] = []
  for (const e of empleados) {
    if (!(e.neto > 0)) { avisos.push({ codigo: 'NETO_CERO', legajo_id: e.legajo_id, nombre: e.nombre }); continue }
    const cuil = sd(e.cuil)
    const cbu = sd(e.cbu)
    if (!cuil) avisos.push({ codigo: 'SIN_CUIL', legajo_id: e.legajo_id, nombre: e.nombre })
    if (!cbu) avisos.push({ codigo: 'SIN_CBU', legajo_id: e.legajo_id, nombre: e.nombre })
    filasB.push({ legajo_id: e.legajo_id, cuil, nombre: e.nombre, cbu, importe: r2(e.neto) })
  }
  const dec = opts.decimal === 'punto' ? '.' : ','
  const fmt = (x: number) => x.toFixed(2).replace('.', dec)
  const limpio = (s: string) => s.replace(/[;\r\n"]/g, ' ').trim()
  const csv = ['CUIL;Apellido y nombre;CBU;Importe',
    ...filasB.map(f => `${f.cuil};${limpio(f.nombre)};${f.cbu};${fmt(f.importe)}`)].join('\r\n') + '\r\n'
  const total = r2(filasB.reduce((s, f) => s + f.importe, 0))
  return { archivo: `banco_${liq.codigo}.csv`, filas: filasB, total, avisos, csv }
}

// ── Resumen para el contador ────────────────────────────────────────────────

export function resumenContador(liq: LiquidacionExport, empleados: EmpleadoExport[]) {
  const avisos: AvisoExport[] = []
  const porConcepto = new Map<string, {
    clave: string; concepto_id: number | null; codigo_arca: string | null; nombre: string; tipo: LineaExport['tipo'];
    destino: string | null; grupo_contribucion: string | null; importe: number; cantidad: number; empleados: number
  }>()
  const sinArca = new Set<string>()
  for (const e of empleados) {
    for (const l of e.lineas) {
      const clave = l.concepto_id != null ? `c${l.concepto_id}` : `m:${l.tipo}:${l.nombre}`
      const x = porConcepto.get(clave) ?? {
        clave, concepto_id: l.concepto_id, codigo_arca: l.codigo_arca, nombre: l.nombre, tipo: l.tipo,
        destino: l.destino, grupo_contribucion: l.grupo_contribucion, importe: 0, cantidad: 0, empleados: 0,
      }
      x.importe = r2(x.importe + l.importe)
      x.cantidad = r2(x.cantidad + (l.cantidad ?? 0))
      x.empleados += 1
      porConcepto.set(clave, x)
      if (!l.codigo_arca && l.tipo !== 'contribucion') sinArca.add(l.nombre)
    }
  }
  if (sinArca.size) avisos.push({ codigo: 'SIN_CODIGO_ARCA', detalle: { conceptos: [...sinArca] } })
  const orden: Record<LineaExport['tipo'], number> = { remunerativo: 0, no_remunerativo: 1, descuento: 2, contribucion: 3 }
  const conceptos = [...porConcepto.values()].sort((a, b) => orden[a.tipo] - orden[b.tipo] || (a.codigo_arca ?? 'z').localeCompare(b.codigo_arca ?? 'z') || a.nombre.localeCompare(b.nombre))
  const sum = (k: keyof EmpleadoExport) => r2(empleados.reduce((s, e) => s + Number(e[k] ?? 0), 0))
  const totales = {
    empleados: empleados.length, remunerativo: sum('total_remunerativo'), no_remunerativo: sum('total_no_remunerativo'),
    descuentos: sum('total_descuentos'), neto: sum('neto'), contribuciones: sum('total_contribuciones'), fondo_cese: sum('fondo_cese'),
  }
  // Pasivos por destino (lo que hay que pagar además del neto): F.931, sindicato, fondo de cese…
  const porDestino: Record<string, number> = {}
  for (const c of conceptos) if (c.tipo === 'descuento' || c.tipo === 'contribucion') {
    const d = c.destino ?? 'otros'
    porDestino[d] = r2((porDestino[d] ?? 0) + c.importe)
  }
  return {
    liquidacion: liq,
    empleados: empleados.map(e => ({
      legajo_id: e.legajo_id, leg: e.leg, nombre: e.nombre, cuil: e.cuil, categoria: e.categoria,
      dias_trabajados: e.dias_trabajados, horas_trabajadas: e.horas_trabajadas,
      total_remunerativo: e.total_remunerativo, total_no_remunerativo: e.total_no_remunerativo,
      total_descuentos: e.total_descuentos, neto: e.neto, total_contribuciones: e.total_contribuciones, fondo_cese: e.fondo_cese,
      lineas: e.lineas,
    })),
    conceptos,
    por_destino: porDestino,
    totales,
    avisos,
  }
}

// ── LSD ─────────────────────────────────────────────────────────────────────

/**
 * Códigos del F.931 del registro 04. Condición, actividad y modalidad salen de cada
 * legajo (o de su convenio: UOCRA 5/003/24, UECARA y Camioneros 1/049/8, jubilados
 * condición 2), tal como los declara el F.931 de CADINC. Lo de acá es el último recurso.
 */
export interface CodigosF931 {
  situacion: string        // 2 — 1 activo
  condicion: string        // 2 — texto, alineado a la izquierda
  actividad: string        // 3 — con ceros
  modalidad: string        // 3 — texto, alineado a la izquierda
  siniestrado: string      // 2 — texto, alineado a la izquierda
  localidad: string        // 2 — parámetro f931_localidad (84 en el F.931 de CADINC)
  tipo_empresa: string     // 1
  obra_social: string      // 6 — si el legajo no tiene código
}

export const CODIGOS_F931_DEFAULT: CodigosF931 = {
  situacion: '1', condicion: '1', actividad: '049', modalidad: '8', siniestrado: '0', localidad: '00',
  tipo_empresa: '1', obra_social: '000000',
}

/** Código sin ceros a la izquierda: la planilla de ARCA arma condición/modalidad/siniestrado como texto. */
const codTxt = (v: string) => String(v).trim().replace(/^0+(?=\d)/, '')

/** Conceptos ARCA que exigen la cantidad en el registro 03 (Guía 15). */
const PIDE_CANTIDAD = new Set(['120003', '150000', '130000', '130001', '130002', '130003'])
const esSac = (arca: string | null) => !!arca && /^12\d{4}$/.test(arca) && arca !== '120003'

const izq = (s: string, len: number) => s.slice(0, len).padEnd(len, ' ')
const der = (s: string, len: number) => s.slice(0, len).padStart(len, ' ')
const cero = (s: string, len: number) => s.replace(/\D/g, '').slice(-len).padStart(len, '0')
/** Importe con 2 decimales implícitos, sin separador, relleno con ceros. */
const imp = (x: number, len = 15) => cero(String(Math.round(Math.abs(r2(x)) * 100)), len)
const ymd = (iso: string | null) => (iso ? iso.slice(0, 10).replace(/-/g, '') : '').padEnd(8, ' ')
/** ANSI: el LSD rechaza lo que no entra en windows-1252; se sacan saltos y separadores. */
const texto = (s: string) => s.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()

/** Código de concepto del empleador en el LSD (máx. 10). Estable: no depende del nombre. */
export function codigoEmpleadorLsd(l: { concepto_id: number | null; tipo: LineaExport['tipo'] }): string {
  if (l.concepto_id != null) return `C${l.concepto_id}`
  return l.tipo === 'descuento' ? 'MDESC' : l.tipo === 'no_remunerativo' ? 'MNOREM' : 'MREM'
}

const UNIDADES: Record<string, string> = { horas: 'H', dias: 'D', '%': '%', meses: 'M', anios: 'A', quincenas: 'Q', '$': '$' }

export function generarLsd(args: {
  cuit: string
  liquidacion: LiquidacionExport
  empleados: EmpleadoExport[]
  detraccion?: number
  codigos?: Partial<CodigosF931>
}) {
  const liq = args.liquidacion
  const cod = { ...CODIGOS_F931_DEFAULT, ...(args.codigos ?? {}) }
  const avisos: AvisoExport[] = []
  if (liq.estado !== 'cerrada') avisos.push({ codigo: 'LIQUIDACION_NO_CERRADA', detalle: { estado: liq.estado } })
  const sinCodigos = args.empleados.filter(e => !e.f931_condicion || !e.f931_actividad || !e.f931_modalidad)
  if (sinCodigos.length) avisos.push({ codigo: 'CODIGOS_F931_POR_DEFECTO', detalle: { codigos: { condicion: cod.condicion, actividad: cod.actividad, modalidad: cod.modalidad }, empleados: sinCodigos.map(e => e.nombre) } })
  if (cod.localidad === '00') avisos.push({ codigo: 'SIN_LOCALIDAD_F931' })
  avisos.push({ codigo: 'BASES_SIN_TOPE', detalle: { mensaje: 'Las bases imponibles 1–9 se informan iguales a la remuneración, sin el tope de ANSES: revisar con el contador los sueldos altos.' } })
  if (!liq.fecha_pago) avisos.push({ codigo: 'SIN_FECHA_PAGO' })
  const periodo = liq.periodo.slice(0, 7).replace('-', '')
  const mes = Number(periodo.slice(4, 6))
  const tipoLiq = liq.tipo === 'quincena' ? 'Q' : 'M'
  const incluidos = args.empleados.filter(e => {
    if (!sd(e.cuil)) { avisos.push({ codigo: 'SIN_CUIL', legajo_id: e.legajo_id, nombre: e.nombre }); return false }
    return true
  })
  const out: string[] = []
  out.push('01' + cero(args.cuit, 11) + 'SJ' + periodo + tipoLiq + cero(String(liq.numero), 5) + '30' + cero(String(incluidos.length), 6))

  const sinArca = new Set<string>()
  const sinCantidad = new Set<string>()
  const sacFuera = new Set<string>()
  for (const e of incluidos) {
    const cuil = cero(sd(e.cuil), 11)
    const cbu = sd(e.cbu)
    if (cbu && cbu.length !== 22) avisos.push({ codigo: 'CBU_INVALIDA', legajo_id: e.legajo_id, nombre: e.nombre })
    const acredita = cbu.length === 22
    out.push('02' + cuil + izq(String(e.leg ?? e.legajo_id), 10) + izq('', 50) + der(acredita ? cbu : '', 22) + '000'
      + ymd(liq.fecha_pago) + izq('', 8) + (acredita ? '3' : '1'))
    for (const l of e.lineas) {
      if (l.tipo === 'contribucion') continue
      if (!l.codigo_arca) sinArca.add(l.nombre)
      if (esSac(l.codigo_arca) && mes !== 6 && mes !== 12) sacFuera.add(l.nombre)
      const unidad = UNIDADES[l.unidad ?? ''] ?? ' '
      const pide = !!l.codigo_arca && PIDE_CANTIDAD.has(l.codigo_arca)
      if (pide && !(l.cantidad && l.cantidad > 0)) sinCantidad.add(l.nombre)
      const cant = l.cantidad != null && (pide || unidad === 'H' || unidad === 'D')
        ? cero(String(Math.round(Math.min(999.99, Math.abs(l.cantidad)) * 100)), 5) : '00000'
      const credito = l.tipo === 'descuento' ? l.importe < 0 : l.importe >= 0
      out.push('03' + cuil + izq(codigoEmpleadorLsd(l), 10) + cant + unidad + imp(l.importe) + (credito ? 'C' : 'D') + izq('', 6))
    }
  }
  if (sinArca.size) avisos.push({ codigo: 'SIN_CODIGO_ARCA', detalle: { conceptos: [...sinArca] } })
  if (sinCantidad.size) avisos.push({ codigo: 'CANTIDAD_REQUERIDA', detalle: { conceptos: [...sinCantidad], mensaje: 'SAC proporcional, adelanto vacacional y horas extras necesitan la cantidad (días u horas).' } })
  if (sacFuera.size) avisos.push({ codigo: 'SAC_FUERA_DE_JUNIO_DICIEMBRE', detalle: { conceptos: [...sacFuera], mensaje: 'ARCA solo acepta SAC en junio y diciembre, salvo el SAC proporcional (120003).' } })

  const detraccion = args.detraccion ?? 0
  for (const e of incluidos) {
    const cuil = cero(sd(e.cuil), 11)
    const rem = r2(e.total_remunerativo)
    const bruta = r2(e.total_remunerativo + e.total_no_remunerativo)
    const os = e.obra_social_codigo ? cero(e.obra_social_codigo, 6) : cod.obra_social
    if (!e.obra_social_codigo) avisos.push({ codigo: 'SIN_OBRA_SOCIAL', legajo_id: e.legajo_id, nombre: e.nombre })
    // Días u horas: uno de los dos va en 0 (reg. 04). Los jornalizados informan horas.
    const horas = Math.min(999, Math.round(e.horas_trabajadas ?? 0))
    const dias = horas > 0 ? 0 : Math.min(99, Math.round(e.dias_trabajados ?? (liq.tipo === 'quincena' ? 15 : 30)))
    const detraer = Math.min(detraccion, rem)
    const bases = Array.from({ length: 9 }, () => imp(rem)).join('')
    out.push('04' + cuil
      + (e.conyuge_a_cargo ? '1' : '0') + cero(String(e.hijos_a_cargo ?? 0), 2)
      + '1' /* CCT */ + '1' /* SCVO */ + '0' /* reducción */ + cod.tipo_empresa + '0' /* tipo de operación */
      + cero(cod.situacion, 2) + izq(codTxt(e.f931_condicion || cod.condicion), 2) + cero(e.f931_actividad || cod.actividad, 3)
      + izq(codTxt(e.f931_modalidad || cod.modalidad), 3)
      + izq(codTxt(cod.siniestrado), 2) + cero(cod.localidad, 2)
      + cero(cod.situacion, 2) + '01' + '00' + '00' + '00' + '00' // situaciones de revista 1–3 con su día de inicio
      + cero(String(dias), 2) + cero(String(horas), 3)
      + '00000' /* % aporte adicional SS */ + '00000' /* contribución tarea diferencial */
      + os + '00' /* adherentes */
      + imp(0) + imp(0) + imp(0) + imp(0) + imp(0) /* adicionales OS y bases diferenciales OS/LRT */
      + imp(0) /* remuneración maternidad ANSES */
      + imp(bruta) /* remuneración bruta */
      + bases /* bases imponibles 1–9 */
      + imp(0) + imp(0) /* bases diferenciales aporte / contribución SS */
      + imp(rem - detraer) /* base imponible 10 */
      + imp(detraer) /* importe a detraer */)
  }
  const contenido = out.join('\r\n') + '\r\n'
  return {
    archivo: `LSD_${periodo}_${liq.codigo}.txt`,
    registros: { '01': 1, '02': incluidos.length, '03': out.filter(x => x.startsWith('03')).length, '04': incluidos.length },
    avisos,
    contenido,
  }
}

// ── LSD: parametrización de conceptos ────────────────────────────────────────

export interface ConceptoLsd {
  id: number
  codigo_arca: string | null
  nombre: string
  tipo: LineaExport['tipo']
}

/**
 * Subsistemas en los que tributa el concepto (posiciones del TXT de conceptos, en orden):
 * SIPA ap/co, INSSJyP ap/co, OS ap/co, FSR ap/co, RENATEA ap/co, AAFF, FNE, LRT, reg. diferenciales, reg. especiales.
 * Criterio de la planilla de ARCA: remunerativo → todos en 1 (menos diferenciales/especiales);
 * descuento → todos en 0; no remunerativo → según el grupo ARCA (530000 aportes OS/FSR,
 * 540000 aportes y contribuciones OS/FSR; el resto en 0).
 */
export function subsistemasConcepto(c: ConceptoLsd): string {
  if (c.tipo === 'remunerativo') return '1111111111' + '111' + '00'
  if (c.tipo === 'no_remunerativo' && c.codigo_arca) {
    if (/^53\d{4}$/.test(c.codigo_arca)) return '0000101000' + '000' + '00'
    if (/^54\d{4}$/.test(c.codigo_arca)) return '0000111100' + '000' + '00'
  }
  return '0000000000' + '000' + '00'
}

/** TXT de «carga masiva de conceptos» del LSD (195 posiciones por línea). */
export function generarConceptosLsd(conceptos: ConceptoLsd[]) {
  const avisos: AvisoExport[] = []
  const out: string[] = []
  const sinArca: string[] = []
  for (const c of conceptos) {
    if (c.tipo === 'contribucion') continue
    if (!c.codigo_arca || !/^\d{6}$/.test(c.codigo_arca)) { sinArca.push(c.nombre); continue }
    const f = subsistemasConcepto(c)
    // Orden del registro: 10 marcas (SIPA…RENATEA) · libre · AAFF · libre · FNE · libre · LRT · diferenciales · libre · especiales · libre(9)
    out.push(c.codigo_arca + izq(`C${c.id}`, 10) + izq(texto(c.nombre), 150) + '1'
      + f.slice(0, 10) + ' ' + f[10] + ' ' + f[11] + ' ' + f[12] + f[13] + ' ' + f[14] + izq('', 9))
  }
  if (sinArca.length) avisos.push({ codigo: 'SIN_CODIGO_ARCA', detalle: { conceptos: sinArca, mensaje: 'Estos conceptos no se pueden dar de alta en el LSD hasta tener su código ARCA.' } })
  return { archivo: 'LSD_conceptos_CADINC.txt', conceptos: out.length, avisos, contenido: out.join('\r\n') + '\r\n' }
}
