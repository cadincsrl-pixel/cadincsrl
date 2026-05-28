// Lee `materiales_a_cuenta_cliente` (MCC) — el listado de qué se le imputa
// al cliente por cada obra. La diferencia clave vs `solicitud_compra_item`
// es que el MCC ya tiene resueltos los joins y el `pagado_por` definido al
// momento de la compra/retiro.
//
// El campo `pagado_por` distingue:
// - 'cadinc': CADINC adelantó → suma a la deuda del cliente.
// - 'cliente': el cliente pagó directo al proveedor → registro de rendición.
//
// El endpoint NO suma ni agrega: devuelve la lista cruda con joins. El
// frontend calcula los totales con `useMemo` para mantener la UI reactiva
// a filtros (por obra, por pagador, por proveedor).

import { createSupabaseClient } from '../../lib/supabase.js'

export const cuentaClienteService = {
  /**
   * Filas de MCC para una obra (con joins a proveedor, factura, obra).
   * Ordenadas por `fecha_resolucion` DESC para que lo más reciente quede arriba.
   */
  async getByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('materiales_a_cuenta_cliente')
      .select(`
        *,
        proveedores(nombre),
        facturas_compra(numero, adjunto_url, fecha)
      `)
      .eq('obra_cod', obraCod)
      .order('fecha_resolucion', { ascending: false })
    if (error) throw new Error(error.message)
    return data ?? []
  },

  /**
   * Filas de MCC para una lista de obras (caso "todas las obras del usuario").
   * Misma forma que `getByObra` pero con filtro `in`.
   */
  async getByObras(obraCods: string[], token: string) {
    if (obraCods.length === 0) return []
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('materiales_a_cuenta_cliente')
      .select(`
        *,
        proveedores(nombre),
        facturas_compra(numero, adjunto_url, fecha)
      `)
      .in('obra_cod', obraCods)
      .order('fecha_resolucion', { ascending: false })
    if (error) throw new Error(error.message)
    return data ?? []
  },
}
