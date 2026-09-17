// =====================================================================
// Resumen de cuenta corriente de TODAS las obras — el cálculo, sin I/O.
//
// Una fila por obra con lo que el user pidió el 17/09: jornales con su %,
// contratistas con su %, materiales con su %, total, pagado y saldo. Es la
// misma cuenta que arma `useAdministracionCuenta` en el front para UNA obra
// (sección "POR ADMINISTRACIÓN"), hecha en el servidor para todas a la vez:
// bajar las horas de 30 obras al navegador es el tráfico que fundió el
// bandwidth de Render en agosto, y además pisa el tope de 1000 filas (§5.7).
//
// La fórmula de jornales NO se reescribe: es `calcularCostoObra`, la copia
// fiel del front que ya usa "Imputar lo pagado". Acá sólo se le aplica el %
// y se suma.
//
// LA REGLA QUE CAMBIA EL NÚMERO — el régimen de la obra:
//
//   · por administración → el cliente paga costo + % por pata. Total =
//     jornales×(1+%) + contratistas×(1+%) + materiales×(1+%).
//   · presupuesto cerrado → el cliente paga el precio pactado, y la mano de
//     obra y los contratistas están ADENTRO de ese precio. Lo único que se le
//     cobra por acá son los materiales. Jornales y contratistas se devuelven
//     igual (son el costo, sirven para ver el margen) pero con
//     `en_cuenta = false`, y NO entran al total ni al saldo.
//
//   Si en las obras de presupuesto cerrado (17 de 22 activas) se sumaran los
//   jornales como deuda, el saldo se inflaría con plata que nunca se va a
//   cobrar. Las llave en mano y las internas no llegan acá: no hay nada que
//   cobrarles por este canal.
//
// Dos cosas que se respetan de la cuenta por obra:
//   · El % vigente se aplica POR SEMANA (jornales y contratistas) o por FECHA
//     del renglón (materiales), con la versión vigente en ese momento: un
//     cambio de % a mitad de obra vale desde su viernes y no re-factura lo
//     anterior.
//   · Una semana ya cubierta por un pago usa el monto CONGELADO en
//     `cuenta_admin_imputaciones`, no el cálculo vivo: lo que el cliente ya
//     pagó no se mueve más aunque una tarifa cambie retroactivamente.
// =====================================================================

import { calcularCostoObra, type PersonalRow, type CategoriaRow } from '../horas/costo-obra.js'

export type Regimen = 'administracion' | 'presupuesto_cerrado'

export interface ObraResumenInput {
  cod: string
  nom: string
  /** `obras.cc`, el centro de costo: el CLIENTE, que puede pagar varias obras juntas. */
  cc: string | null
  archivada: boolean
  por_administracion: boolean
}

export interface PctRow {
  obra_cod: string
  desde: string
  pct_operarios: number
  pct_contratistas: number
  pct_materiales: number
}

export interface DatosResumenObras {
  obras:        ObraResumenInput[]
  /** Horas ya sumadas por (obra, viernes, legajo): RPC `horas_semana_leg`. */
  horasSemLeg:  { obra_cod: string; sem_key: string; leg: string; horas: number }[]
  hsExtras:     { obra_cod: string; leg: string; sem_key: string; hs: number }[]
  personal:     PersonalRow[]
  categorias:   CategoriaRow[]
  tarifas:      { obra_cod: string; cat_id: number; vh: number | null; desde: string }[]
  catObra:      { obra_cod: string; leg: string; cat_id: number; desde: string }[]
  pcts:         PctRow[]
  certs:        { obra_cod: string; sem_key: string; monto: number }[]
  imputaciones: { obra_cod: string; sem_key: string; pata: string; monto: number }[]
  /** Renglones de la cuenta del cliente en `a_cobrar` o `cobrado`. */
  materiales:   { obra_cod: string; fecha_resolucion: string | null; precio_total: number; precio_unit: number }[]
  cobros:       { obra_cod: string; monto: number }[]
  /** Notas de crédito NO anuladas. */
  notas:        { obra_cod: string; monto: number }[]
}

export interface PataResumen {
  costo:      number
  facturable: number
  /** false en presupuesto cerrado: es costo, no deuda del cliente. */
  en_cuenta:  boolean
  /** El % vigente hoy, para mostrarlo. null si la obra no tiene porcentajes. */
  pct:        number | null
}

export interface ResumenObraFila {
  obra_cod:     string
  obra_nom:     string
  /**
   * El centro de costo, para agrupar: ANIMAR paga sus cuatro clínicas con un
   * solo saldo, BRADEL sus farmacias. Sin `cc` cargado, la obra es su propio
   * centro — nunca queda fuera de la agrupación.
   */
  centro_costo: string
  archivada:    boolean
  regimen:      Regimen
  /** null cuando el que pide no puede ver costos de tarja (`parcial = true`). */
  jornales:     PataResumen | null
  contratistas: PataResumen | null
  materiales:   { costo: number; facturable: number; sin_precio: number; pct: number | null }
  total:        number
  pagado:       number
  notas:        number
  saldo:        number
  /** Por administración y sin una sola versión de porcentajes: calcula al 0%. */
  sin_pct:      boolean
  /** Sin jornales ni contratistas por permisos: el total no es el total. */
  parcial:      boolean
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** La versión de porcentajes vigente a una fecha: la de mayor `desde` que no la pasa. */
function pctVigente(pcts: PctRow[], fechaISO: string): PctRow | null {
  let mejor: PctRow | null = null
  for (const p of pcts) {
    if (p.desde <= fechaISO && (!mejor || p.desde > mejor.desde)) mejor = p
  }
  return mejor
}

function agrupar<T extends { obra_cod: string }>(filas: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const f of filas) {
    const lista = m.get(f.obra_cod)
    if (lista) lista.push(f)
    else m.set(f.obra_cod, [f])
  }
  return m
}

export function armarResumenObras(d: DatosResumenObras, hoyISO: string, conTarja: boolean): ResumenObraFila[] {
  const horasPor   = agrupar(d.horasSemLeg)
  const extrasPor  = agrupar(d.hsExtras)
  const tarifasPor = agrupar(d.tarifas)
  const catObraPor = agrupar(d.catObra)
  const pctsPor    = agrupar(d.pcts)
  const certsPor   = agrupar(d.certs)
  const imputPor   = agrupar(d.imputaciones)
  const matPor     = agrupar(d.materiales)
  const cobrosPor  = agrupar(d.cobros)
  const notasPor   = agrupar(d.notas)

  const filas: ResumenObraFila[] = []

  for (const obra of d.obras) {
    const cod = obra.cod
    const regimen: Regimen = obra.por_administracion ? 'administracion' : 'presupuesto_cerrado'
    const esAdmin = regimen === 'administracion'
    // En presupuesto cerrado los porcentajes no existen por construcción
    // (cargarlos ES marcar la obra por administración), pero si quedara
    // alguno de una época anterior no tiene que contar.
    const pcts = esAdmin ? (pctsPor.get(cod) ?? []) : []
    const pctHoy = pctVigente(pcts, hoyISO)
    const imput = imputPor.get(cod) ?? []
    const congelada = (sem: string, pata: 'operarios' | 'contratistas') =>
      imput.find(i => i.sem_key.slice(0, 10) === sem && i.pata === pata)

    // ── Jornales ──
    let jornales: PataResumen | null = null
    let contratistas: PataResumen | null = null
    if (conTarja) {
      const horas = (horasPor.get(cod) ?? []).map(h => ({ leg: h.leg, fecha: h.sem_key.slice(0, 10), horas: Number(h.horas) }))
      const extras = (extrasPor.get(cod) ?? []).map(e => ({ leg: e.leg, sem_key: e.sem_key, hs: Number(e.hs) }))
      const costo = calcularCostoObra({
        horas, hsExtras: extras,
        personal: d.personal, categorias: d.categorias,
        tarifas: tarifasPor.get(cod) ?? [], catObra: catObraPor.get(cod) ?? [],
        hoyISO,
      })
      let moCosto = 0, moFact = 0
      for (const sem of costo.semanas) {
        if (sem.costo <= 0) continue
        moCosto += sem.costo
        const cong = congelada(sem.sem_key, 'operarios')
        const pct = Number(pctVigente(pcts, sem.sem_key)?.pct_operarios ?? 0)
        moFact += cong ? Number(cong.monto) : sem.costo * (1 + pct / 100)
      }
      jornales = { costo: r2(moCosto), facturable: r2(esAdmin ? moFact : moCosto), en_cuenta: esAdmin, pct: pctHoy ? Number(pctHoy.pct_operarios) : null }

      // ── Contratistas: certificaciones sumadas por semana ──
      const certPorSem = new Map<string, number>()
      for (const c of certsPor.get(cod) ?? []) {
        const k = c.sem_key.slice(0, 10)
        certPorSem.set(k, (certPorSem.get(k) ?? 0) + Number(c.monto ?? 0))
      }
      let contCosto = 0, contFact = 0
      for (const [sem, monto] of certPorSem) {
        if (monto <= 0) continue
        contCosto += monto
        const cong = congelada(sem, 'contratistas')
        const pct = Number(pctVigente(pcts, sem)?.pct_contratistas ?? 0)
        contFact += cong ? Number(cong.monto) : monto * (1 + pct / 100)
      }
      contratistas = { costo: r2(contCosto), facturable: r2(esAdmin ? contFact : contCosto), en_cuenta: esAdmin, pct: pctHoy ? Number(pctHoy.pct_contratistas) : null }
    }

    // ── Materiales: la cuenta del cliente, con el % vigente a la fecha de cada renglón ──
    let matCosto = 0, matFact = 0, sinPrecio = 0
    for (const m of matPor.get(cod) ?? []) {
      const total = Number(m.precio_total ?? 0)
      matCosto += total
      const pct = Number(pctVigente(pcts, m.fecha_resolucion ?? hoyISO)?.pct_materiales ?? 0)
      matFact += total * (1 + pct / 100)
      if (Number(m.precio_unit ?? 0) === 0) sinPrecio++
    }
    const materiales = { costo: r2(matCosto), facturable: r2(matFact), sin_precio: sinPrecio, pct: pctHoy ? Number(pctHoy.pct_materiales) : null }

    // ── Total, pagado, saldo ──
    const enCuenta = (p: PataResumen | null) => (p && p.en_cuenta ? p.facturable : 0)
    const total  = r2(enCuenta(jornales) + enCuenta(contratistas) + materiales.facturable)
    const pagado = r2((cobrosPor.get(cod) ?? []).reduce((s, c) => s + Number(c.monto ?? 0), 0))
    const notas  = r2((notasPor.get(cod) ?? []).reduce((s, n) => s + Number(n.monto ?? 0), 0))

    filas.push({
      obra_cod: cod, obra_nom: obra.nom,
      centro_costo: (obra.cc ?? '').trim() || obra.nom,
      archivada: obra.archivada, regimen,
      jornales, contratistas, materiales,
      total, pagado, notas, saldo: r2(total - pagado - notas),
      sin_pct: esAdmin && pcts.length === 0,
      parcial: esAdmin && !conTarja,
    })
  }

  // Lo que más debe, primero. Empate: por nombre.
  return filas.sort((a, b) => b.saldo - a.saldo || a.obra_nom.localeCompare(b.obra_nom))
}
