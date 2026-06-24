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
import type { CrearCobroDto, EditarCobroDto } from './cuenta-cliente.schema.js'

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

  /**
   * Conteo de materiales "sin precio" (precio_unit=0, a tasar) por obra, en
   * las obras dadas (null = todas, para admin). Sirve para que Alina/Nicolás
   * vean los pendientes de tasar sin recorrer obra por obra. Devuelve
   * [{ obra_cod, sin_precio }] ordenado de mayor a menor.
   */
  async pendientesDePrecio(obraCods: string[] | null, token: string) {
    const supabase = createSupabaseClient(token)
    // Vista agregada (una fila por obra) para no chocar con el cap de 1000 de
    // PostgREST si crece el backlog de ítems sin tasar (CLAUDE.md §5.7).
    const base = supabase.from('v_cuenta_cliente_pendientes').select('obra_cod, sin_precio')
    const { data, error } = obraCods != null ? await base.in('obra_cod', obraCods) : await base
    if (error) throw new Error(error.message)
    return ((data ?? []) as Array<{ obra_cod: string; sin_precio: number }>)
      .sort((a, b) => b.sin_precio - a.sin_precio)
  },

  // ── Cobros (pagos del cliente a cuenta de la obra) ───────────────────

  /** Cobros de una obra, más recientes primero. */
  async getCobros(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
    if (error) throw new Error(error.message)
    return data ?? []
  },

  /** obra_cod de un cobro (para validar scope en PATCH/DELETE). null si no existe. */
  async getCobroObra(id: number, token: string): Promise<string | null> {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros').select('obra_cod').eq('id', id).maybeSingle()
    if (error) throw new Error(error.message)
    return data?.obra_cod ?? null
  },

  async crearCobro(dto: CrearCobroDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async editarCobro(id: number, dto: EditarCobroDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
    const { data, error } = await supabase
      .from('cuenta_cliente_cobros')
      .update({ ...patch, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async eliminarCobro(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('cuenta_cliente_cobros').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
