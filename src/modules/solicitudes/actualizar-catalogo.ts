// Regla de "poner el precio de esta compra en el catalogo" (20260911).
// Pura a proposito: se testea sin mocks y la usan el service y el endpoint
// de sugerencia. La compatibilidad de unidades NO se recalcula aca: viene
// resuelta por unidad_compatible() de la base, que es la unica fuente.

export type CtxActualizarCatalogo = {
  material_id: number | null
  unidad_renglon: string | null
  unidad_ficha: string | null
  unidad_compatible: boolean
  precio_unit: number
  /** Fecha del precio: la de la factura si hay, si no hoy (YYYY-MM-DD). */
  fecha_precio: string | null
  /** stock_materiales.precio_actualizado_en (ISO) del precio vigente. */
  precio_actualizado_en: string | null
  /** stock_materiales.precio_ref vigente. Con 0 no hay precio que proteger. */
  precio_vigente: number
}

/** Fecha calendario argentina (YYYY-MM-DD) de un instante ISO. La base esta en UTC
 *  y las facturas se fechan en hora local: comparar en UTC daba falsos positivos
 *  para todo precio fijado entre las 21 y las 24. */
export function fechaART(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
}

export type RechazoCatalogo = { code: string; detalle: Record<string, unknown> }

export function validarActualizacionCatalogo(x: CtxActualizarCatalogo): RechazoCatalogo | null {
  if (!x.material_id) return { code: 'SIN_FICHA', detalle: {} }
  if (!(x.precio_unit > 0)) return { code: 'PRECIO_INVALIDO', detalle: { precio_unit: x.precio_unit } }
  if (!x.unidad_compatible) {
    return { code: 'UNIDAD_DISTINTA', detalle: { unidad_renglon: x.unidad_renglon, unidad_ficha: x.unidad_ficha } }
  }
  // Una factura vieja cargada tarde no pisa un precio mas nuevo. Si la ficha
  // no tiene precio (0), no hay nada que proteger aunque la fecha este seteada.
  const vigenteDesde = x.precio_vigente > 0 && x.precio_actualizado_en ? fechaART(x.precio_actualizado_en) : null
  if (x.fecha_precio && vigenteDesde && x.fecha_precio < vigenteDesde) {
    return { code: 'FACTURA_ANTERIOR_AL_PRECIO', detalle: { fecha_factura: x.fecha_precio, precio_vigente_desde: vigenteDesde } }
  }
  return null
}
