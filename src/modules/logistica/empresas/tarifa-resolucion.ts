// Resolución de la tarifa $/ton de un viaje — PORT del frontend
// (frontend_cadinc_gestion/src/modules/logistica/utils/tarifas.ts).
//
// Está duplicado a propósito: los guards de "esta tarifa ya se facturó"
// (empresas.service.ts) tienen que contar exactamente las facturas que el
// desglose de FacturacionTab le muestra al usuario. Cualquier criterio
// "parecido" hace que el cartel liste facturas que no corresponden — y un
// cartel que miente entrena a la gente a apretar "Corregir igual" sin leer.
//
// Si cambia la escalera en el frontend, hay que cambiarla acá. Los tests de
// src/__tests__/tarifas.test.ts (frontend) congelan el criterio original.

export type TarifaRow = {
  id:            number
  empresa_id:    number
  cantera_id:    number
  deposito_id:   number | null
  tipo_unidad:   'batea' | 'chasis' | null
  valor_ton:     number
  vigente_desde: string
}

export type CamionRow = { id: number; categoria: string | null }

/** Normaliza una fila de `tarifas_empresa_cantera` de PostgREST: los numeric
 *  vienen como string y los nullable como undefined según el select. */
export function normalizarTarifa(t: Record<string, unknown>): TarifaRow {
  return {
    id:            Number(t.id),
    empresa_id:    Number(t.empresa_id),
    cantera_id:    Number(t.cantera_id),
    deposito_id:   t.deposito_id == null ? null : Number(t.deposito_id),
    tipo_unidad:   (t.tipo_unidad ?? null) as 'batea' | 'chasis' | null,
    valor_ton:     Number(t.valor_ton),
    vigente_desde: String(t.vigente_desde),
  }
}

/** Unidad del viaje según la categoría del camión: chasis → 'chasis';
 *  tractor (o camión desconocido) → 'batea'. */
export function unidadDelCamion(
  camiones: CamionRow[],
  camionId: number | null | undefined,
): 'batea' | 'chasis' {
  if (camionId == null) return 'batea'
  return camiones.find(c => c.id === camionId)?.categoria === 'chasis' ? 'chasis' : 'batea'
}

/** Devuelve la TARIFA (no el valor) con la que se factura un viaje.
 *
 *  Escalera de especificidad — gana el primer pool no vacío:
 *    depósito + unidad  >  depósito  >  unidad  >  general
 *  Dentro del pool gana la de `vigente_desde` más reciente que no supere la
 *  fecha. Las tarifas sin `tipo_unidad` valen para cualquier unidad. */
export function tarifaDelViaje(
  tarifas:    TarifaRow[],
  empresaId:  number,
  canteraId:  number | null,
  depositoId: number | null,
  fecha:      string | null,
  tipoUnidad?: 'batea' | 'chasis',
): TarifaRow | null {
  if (!canteraId || !fecha) return null
  const base = tarifas.filter(t =>
    t.empresa_id === empresaId && t.cantera_id === canteraId && t.vigente_desde <= fecha
  )
  const pools = [
    depositoId != null && tipoUnidad ? base.filter(t => t.deposito_id === depositoId && t.tipo_unidad === tipoUnidad) : [],
    depositoId != null ? base.filter(t => t.deposito_id === depositoId && t.tipo_unidad == null) : [],
    tipoUnidad ? base.filter(t => t.deposito_id == null && t.tipo_unidad === tipoUnidad) : [],
    base.filter(t => t.deposito_id == null && t.tipo_unidad == null),
  ]
  const pool = pools.find(p => p.length > 0) ?? []
  return pool.slice().sort((a, b) => b.vigente_desde.localeCompare(a.vigente_desde))[0] ?? null
}

/** Fecha con la que se resuelve la tarifa de un viaje.
 *
 *  OJO: NO es `tramos.fecha_operacion` — esa columna es generada como
 *  COALESCE(fecha_carga, fecha_vacio) y la usan las liquidaciones. El precio
 *  se resuelve por la fecha de DESCARGA (así lo hace FacturacionTab), que en
 *  la práctica casi nunca coincide con la de carga: al 28/07/2026, 130 de los
 *  133 viajes con cobro tenían fecha_descarga distinta de fecha_carga. */
export function fechaDeTarifa(t: { fecha_descarga?: string | null; fecha_carga?: string | null }): string | null {
  return t.fecha_descarga ?? t.fecha_carga ?? null
}
