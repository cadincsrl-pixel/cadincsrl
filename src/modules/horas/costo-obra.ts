// =====================================================================
// Costo de mano de obra de una obra — cálculo canónico portado del frontend.
//
// ⚠ COPIA FIEL de src/lib/utils/costos.ts del repo frontend
//   (getCatIdEfectivo + getVHConCatObra + costoLegConCatObra + el redondeo
//   per-leg al mil de resumen-semana.ts). Si una fórmula cambia allá, cambia
//   acá — los tests de este módulo congelan los mismos números que los del
//   frontend para que cualquier divergencia reviente en el build.
//
// Reglas (§5.3, §5.11 del CLAUDE.md del frontend):
// - La semana va de VIERNES a jueves; sem_key = ISO del viernes.
// - fechaRef de una semana pasada = su viernes; de la semana ACTUAL = hoy.
// - Categoría efectiva: cat_obra (más reciente <= ref, si no la más antigua)
//   > personal_cat_historial (más reciente <= ref) > personal.cat_id.
// - VH: tarifa de obra para esa cat (más reciente <= ref, si no la más
//   antigua — retroactivo); sin tarifa de obra → precio global versionado
//   (categoria_tarifas, mismo criterio); sin historial → cache categorias.vh.
// - Horas de la semana redondeadas a centésimas; costo por operario-semana
//   = round((hs + extras) * vh / 1000) * 1000  (redondeo al MIL por leg).
// =====================================================================

export interface HoraRow      { leg: string; fecha: string; horas: number }
export interface HsExtraRow   { leg: string; sem_key: string; hs: number }
export interface PersonalRow  {
  leg: string
  cat_id: number
  personal_cat_historial?: { cat_id: number; desde: string }[] | null
}
export interface CategoriaRow {
  id: number
  vh: number | null
  categoria_tarifas?: { vh: number; desde: string }[] | null
}
export interface TarifaRow    { cat_id: number; vh: number; desde: string }
export interface CatObraRow   { leg: string; cat_id: number; desde: string }

export interface CostoSemana  { sem_key: string; hs: number; hs_extras: number; costo: number; operarios: number }
export interface CostoObra    {
  total: number
  horas: number
  semanas: CostoSemana[]
}

// Viernes de la semana de una fecha ISO (equivalente a getViernes del
// frontend, pero sobre strings — sin trampas de timezone del servidor).
export function viernesISO(fechaISO: string): string {
  const d = new Date(fechaISO + 'T12:00:00Z')
  const dw = d.getUTCDay() // 0=Dom
  const diff = dw >= 5 ? dw - 5 : dw + 2
  d.setUTCDate(d.getUTCDate() - diff)
  return d.toISOString().slice(0, 10)
}

const redondearHs = (n: number) => Math.round(n * 100) / 100

function catIdEfectivo(
  catObra: CatObraRow[],
  personal: PersonalRow[],
  leg: string,
  fechaRef: string,
): number | null {
  const hist = catObra.filter(co => co.leg === leg)
  if (hist.length > 0) {
    let best: CatObraRow | null = null
    for (const h of hist) {
      if (h.desde <= fechaRef && (!best || h.desde >= best.desde)) best = h
    }
    if (best) return best.cat_id
    return hist.reduce((a, b) => (a.desde <= b.desde ? a : b)).cat_id
  }
  const p = personal.find(x => x.leg === leg)
  if (!p) return null
  const ph = [...(p.personal_cat_historial ?? [])].sort((a, b) => a.desde.localeCompare(b.desde))
  let catId = p.cat_id
  for (const h of ph) {
    if (h.desde <= fechaRef) catId = h.cat_id
  }
  return catId
}

function vhGlobalEnFecha(cat: CategoriaRow | undefined, fechaRef: string): number {
  if (!cat) return 0
  const hist = [...(cat.categoria_tarifas ?? [])].sort((a, b) => a.desde.localeCompare(b.desde))
  if (!hist.length) return Number(cat.vh ?? 0)
  let vh: number | null = null
  for (const t of hist) {
    if (t.desde <= fechaRef) vh = Number(t.vh)
    else break
  }
  return vh ?? Number(hist[0]!.vh)
}

function vhConCatObra(
  catObra: CatObraRow[],
  personal: PersonalRow[],
  categorias: CategoriaRow[],
  tarifas: TarifaRow[],
  leg: string,
  fechaRef: string,
): number {
  const catId = catIdEfectivo(catObra, personal, leg, fechaRef)
  if (!catId) return 0
  const deObra = tarifas
    .filter(t => t.cat_id === catId)
    .sort((a, b) => a.desde.localeCompare(b.desde))
  if (deObra.length > 0) {
    let vh: number | null = null
    for (const t of deObra) {
      if (t.desde <= fechaRef) vh = Number(t.vh)
      else break
    }
    return vh ?? Number(deObra[0]!.vh)
  }
  return vhGlobalEnFecha(categorias.find(c => c.id === catId), fechaRef)
}

/**
 * Costo total de mano de obra de UNA obra, semana por semana.
 * Inputs ya filtrados por obra (horas, hsExtras, tarifas, catObra).
 * `hoyISO` inyectable para tests (en prod: hoy en hora argentina).
 */
export function calcularCostoObra(args: {
  horas: HoraRow[]
  hsExtras: HsExtraRow[]
  personal: PersonalRow[]
  categorias: CategoriaRow[]
  tarifas: TarifaRow[]
  catObra: CatObraRow[]
  hoyISO: string
}): CostoObra {
  const { horas, hsExtras, personal, categorias, tarifas, catObra, hoyISO } = args
  const viernesActual = viernesISO(hoyISO)

  // Horas por (semana, leg). Un leg puede tener SOLO extras en una semana
  // (sin horas diarias) — también cuenta.
  const porSemLeg = new Map<string, Map<string, number>>()
  for (const h of horas) {
    if (!h.horas || h.horas <= 0) continue
    const sem = viernesISO(h.fecha)
    if (!porSemLeg.has(sem)) porSemLeg.set(sem, new Map())
    const legs = porSemLeg.get(sem)!
    legs.set(h.leg, (legs.get(h.leg) ?? 0) + Number(h.horas))
  }
  const extrasPorSemLeg = new Map<string, number>()
  for (const e of hsExtras) {
    if (!e.hs || e.hs <= 0) continue
    const sem = e.sem_key.slice(0, 10)
    extrasPorSemLeg.set(`${sem}|${e.leg}`, Number(e.hs))
    if (!porSemLeg.has(sem)) porSemLeg.set(sem, new Map())
    if (!porSemLeg.get(sem)!.has(e.leg)) porSemLeg.get(sem)!.set(e.leg, 0)
  }

  const semanas: CostoSemana[] = []
  let total = 0
  let horasTotales = 0

  for (const [semKey, legs] of [...porSemLeg.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fechaRef = semKey === viernesActual ? hoyISO : semKey
    let costoSem = 0, hsSem = 0, extrasSem = 0
    for (const [leg, hsCrudas] of legs) {
      const hs = redondearHs(hsCrudas)
      const extras = extrasPorSemLeg.get(`${semKey}|${leg}`) ?? 0
      const vh = vhConCatObra(catObra, personal, categorias, tarifas, leg, fechaRef)
      // Redondeo al MIL por operario-semana (regla §5.11 del frontend).
      costoSem += Math.round((hs + extras) * vh / 1000) * 1000
      hsSem += hs
      extrasSem += extras
    }
    semanas.push({
      sem_key: semKey,
      hs: redondearHs(hsSem),
      hs_extras: redondearHs(extrasSem),
      costo: costoSem,
      operarios: legs.size,
    })
    total += costoSem
    horasTotales += hsSem + extrasSem
  }

  return { total, horas: redondearHs(horasTotales), semanas }
}
