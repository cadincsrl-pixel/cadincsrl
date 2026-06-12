import { createSupabaseClient } from '../../lib/supabase.js'
import { mobileQuestClient } from '../logistica/gps-sync/mobile-quest.client.js'
import { geocode, distancia } from '../logistica/maps/google-maps.client.js'
import type {
  CreateMaterialDto, UpdateMaterialDto,
  CreateClienteDto, UpdateClienteDto,
  CreatePrecioDto, UpdatePrecioDto,
  CreateMovimientoDto, UpdateMovimientoDto, ListMovimientosQuery,
  CreateCobroDto, UpdateCobroDto, CobrosQuery,
  CreateMunicipioDto, UpdateMunicipioDto,
  CreateCostoCanteraDto, UpdateCostoCanteraDto,
  CreateCanteraDto, UpdateCanteraDto,
  CreateUnidadDto, UpdateUnidadDto,
  CreatePagoCanteraDto, PagosCanteraQuery,
} from './aridos.schema.js'

const MOV_SELECT = `*,
  aridos_materiales(nombre, unidad),
  aridos_clientes(nombre),
  aridos_municipios(nombre, recargo_pct),
  aridos_canteras(nombre),
  aridos_unidades(nombre, patente, chofer)`

// Normaliza patente para matchear contra Mobile Quest (mismo criterio
// que el gps-sync de logística): uppercase, solo alfanuméricos.
function normPatente(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Lee TODAS las filas de una query paginando de a 1000 (hard cap de
// PostgREST que no se bypassea con .range grande — CLAUDE.md §5.7).
async function fetchAll<T>(buildQuery: (from: number, to: number) => any): Promise<T[]> {
  const PAGE = 1000
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    all.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return all
}

export const aridosService = {
  // ── Materiales ──────────────────────────────────────────────
  async getMateriales(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('aridos_materiales').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createMaterial(dto: CreateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_materiales')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMaterial(id: number, dto: UpdateMaterialDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_materiales')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMaterial(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_materiales').delete().eq('id', id)
    if (error) {
      if (error.code === '23503') throw new Error('No se puede eliminar: el material tiene movimientos. Desactivalo en su lugar.')
      throw new Error(error.message)
    }
    return { success: true }
  },

  // ── Clientes ────────────────────────────────────────────────
  async getClientes(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('aridos_clientes').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createCliente(dto: CreateClienteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_clientes')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCliente(id: number, dto: UpdateClienteDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_clientes')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteCliente(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_clientes').delete().eq('id', id)
    if (error) {
      if (error.code === '23503') throw new Error('No se puede eliminar: el cliente tiene ventas o cobros registrados.')
      throw new Error(error.message)
    }
    return { success: true }
  },

  // ── Precios por cliente × material ──────────────────────────
  async getPrecios(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_precios_cliente')
      .select('*, aridos_clientes(nombre), aridos_materiales(nombre, unidad)')
      .order('cliente_id')
      .order('material_id')
      .order('vigente_desde', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createPrecio(dto: CreatePrecioDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_precios_cliente')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updatePrecio(id: number, dto: UpdatePrecioDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_precios_cliente')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deletePrecio(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_precios_cliente').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Movimientos ─────────────────────────────────────────────
  async getMovimientos(query: ListMovimientosQuery, token: string) {
    const supabase = createSupabaseClient(token)
    return fetchAll((from, to) => {
      let q = supabase
        .from('aridos_movimientos')
        .select(MOV_SELECT)
        .order('fecha', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
      if (query.tipo)        q = q.eq('tipo', query.tipo)
      if (query.cliente_id)  q = q.eq('cliente_id', query.cliente_id)
      if (query.material_id) q = q.eq('material_id', query.material_id)
      if (query.fecha_desde) q = q.gte('fecha', query.fecha_desde)
      if (query.fecha_hasta) q = q.lte('fecha', query.fecha_hasta)
      return q
    })
  },

  async createMovimiento(dto: CreateMovimientoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_movimientos')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select(MOV_SELECT)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMovimiento(id: number, dto: UpdateMovimientoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_movimientos')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(MOV_SELECT)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMovimiento(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_movimientos').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Stock del depósito ──────────────────────────────────────
  // Por material: acopios + ajustes − ventas con origen='deposito'.
  // Las ventas directas de cantera no tocan stock.
  async getStock(token: string) {
    const supabase = createSupabaseClient(token)
    const movs = await fetchAll<{ tipo: string; material_id: number; cantidad: number; origen: string | null }>(
      (from, to) => supabase
        .from('aridos_movimientos')
        .select('tipo, material_id, cantidad, origen')
        .order('id')
        .range(from, to)
    )
    const { data: materiales, error } = await supabase
      .from('aridos_materiales')
      .select('id, nombre, unidad, activo')
      .order('nombre')
    if (error) throw new Error(error.message)

    const porMaterial = new Map<number, { entradas: number; salidas: number; ajustes: number }>()
    for (const m of movs) {
      const acc = porMaterial.get(m.material_id) ?? { entradas: 0, salidas: 0, ajustes: 0 }
      const cant = Number(m.cantidad)
      if (m.tipo === 'acopio') acc.entradas += cant
      else if (m.tipo === 'ajuste') acc.ajustes += cant
      else if (m.tipo === 'venta' && m.origen === 'deposito') acc.salidas += cant
      porMaterial.set(m.material_id, acc)
    }

    return (materiales ?? []).map(mat => {
      const acc = porMaterial.get(mat.id) ?? { entradas: 0, salidas: 0, ajustes: 0 }
      return {
        material_id: mat.id,
        nombre:      mat.nombre,
        unidad:      mat.unidad,
        activo:      mat.activo,
        entradas:    acc.entradas,
        salidas:     acc.salidas,
        ajustes:     acc.ajustes,
        stock:       acc.entradas + acc.ajustes - acc.salidas,
      }
    })
  },

  // ── Canteras propias del negocio de áridos ──────────────────
  async getCanteras(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('aridos_canteras').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  // Si viene dirección, se geocodifica best-effort para tener lat/lng
  // (sirve para rutas/tiempos futuros). Si Google falla, se guarda igual.
  async createCantera(dto: CreateCanteraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    let lat: number | null = null
    let lng: number | null = null
    if (dto.direccion) {
      try {
        const g = await geocode(`${dto.direccion}${dto.localidad ? `, ${dto.localidad}` : ''}`)
        lat = g.lat; lng = g.lng
      } catch { /* sin geocode no es bloqueante */ }
    }
    const { data, error } = await supabase
      .from('aridos_canteras')
      .insert({ ...dto, lat, lng, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCantera(id: number, dto: UpdateCanteraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    let extra: Record<string, unknown> = {}
    if (dto.direccion) {
      try {
        const g = await geocode(`${dto.direccion}${dto.localidad ? `, ${dto.localidad}` : ''}`)
        extra = { lat: g.lat, lng: g.lng }
      } catch { /* mantiene lat/lng previos */ }
    }
    const { data, error } = await supabase
      .from('aridos_canteras')
      .update({ ...dto, ...extra, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteCantera(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_canteras').delete().eq('id', id)
    if (error) {
      if (error.code === '23503') throw new Error('No se puede eliminar: la cantera tiene movimientos. Desactivala en su lugar.')
      throw new Error(error.message)
    }
    return { success: true }
  },

  // ── Unidades (camión + chofer, con GPS Mobile Quest) ─────────
  async getUnidades(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('aridos_unidades').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createUnidad(dto: CreateUnidadDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_unidades')
      .insert({ ...dto, patente: dto.patente.toUpperCase().trim(), created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateUnidad(id: number, dto: UpdateUnidadDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const patch: Record<string, unknown> = { ...dto, updated_by: userId }
    if (dto.patente) {
      patch.patente = dto.patente.toUpperCase().trim()
      // Si cambió la patente, el mapping GPS viejo deja de valer.
      patch.id_vehiculo_gps = null
    }
    const { data, error } = await supabase
      .from('aridos_unidades')
      .update(patch)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteUnidad(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_unidades').delete().eq('id', id)
    if (error) {
      if (error.code === '23503') throw new Error('No se puede eliminar: la unidad tiene movimientos. Desactivala en su lugar.')
      throw new Error(error.message)
    }
    return { success: true }
  },

  // ── Posición GPS + tiempo de llegada a destino ───────────────
  // 1. Resuelve el vehículo en Mobile Quest (por mapping previo o por
  //    patente; si matchea, persiste el id para la próxima).
  // 2. Toma la última posición y la cachea en la unidad.
  // 3. Geocodifica la dirección destino y pide tiempo de viaje con
  //    tráfico a Google Distance Matrix.
  async getUnidadEta(id: number, direccion: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data: unidad, error } = await supabase
      .from('aridos_unidades')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)

    // Resolver id_vehiculo_gps por patente si no está mapeado
    let idVehiculo: string | null = unidad.id_vehiculo_gps
    if (!idVehiculo) {
      const catalogo = await mobileQuestClient.listarVehiculos()
      const match = catalogo.find(v => normPatente(v.patente) === normPatente(unidad.patente))
      if (!match) {
        throw new Error(`La patente ${unidad.patente} no aparece en el GPS (Mobile Quest). Verificá que la unidad tenga equipo instalado.`)
      }
      idVehiculo = match.id_vehiculo
      await supabase.from('aridos_unidades').update({ id_vehiculo_gps: idVehiculo }).eq('id', id)
    }

    const datos = await mobileQuestClient.datosUltimos()
    const pos = datos.find(d => d.id_vehiculo === idVehiculo)
    if (!pos || pos.latitud == null || pos.longitud == null) {
      throw new Error('El GPS de la unidad no reporta posición ahora mismo.')
    }

    // Cachear última lectura en la unidad (best-effort)
    await supabase.from('aridos_unidades').update({
      gps_ultima_lat:        pos.latitud,
      gps_ultima_lng:        pos.longitud,
      gps_ultima_velocidad:  pos.velocidad,
      gps_ultima_lectura_en: pos.fecha,
    }).eq('id', id)

    const destino = await geocode(direccion)
    const ruta = await distancia(pos.latitud, pos.longitud, destino.lat, destino.lng)

    return {
      unidad:      { id: unidad.id, nombre: unidad.nombre, patente: unidad.patente, chofer: unidad.chofer },
      posicion:    { lat: pos.latitud, lng: pos.longitud, velocidad: pos.velocidad, lectura_en: pos.fecha },
      destino:     { direccion: destino.formatted_address, lat: destino.lat, lng: destino.lng },
      distancia_km: Math.round(ruta.distancia_m / 100) / 10,
      eta_min:      Math.round(ruta.duracion_s / 60),
      eta_traffic_min: ruta.duracion_traffic_s != null ? Math.round(ruta.duracion_traffic_s / 60) : null,
    }
  },

  // ── Municipios (zonas de entrega con recargo %) ─────────────
  async getMunicipios(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('aridos_municipios').select('*').order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async createMunicipio(dto: CreateMunicipioDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_municipios')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateMunicipio(id: number, dto: UpdateMunicipioDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_municipios')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteMunicipio(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_municipios').delete().eq('id', id)
    if (error) {
      if (error.code === '23503') throw new Error('No se puede eliminar: hay ventas registradas en este municipio.')
      throw new Error(error.message)
    }
    return { success: true }
  },

  // ── Costos de compra por cantera × material ─────────────────
  async getCostosCantera(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_costos_cantera')
      .select('*, aridos_canteras(nombre), aridos_materiales(nombre, unidad)')
      .order('cantera_id')
      .order('concepto')
      .order('vigente_desde', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createCostoCantera(dto: CreateCostoCanteraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_costos_cantera')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCostoCantera(id: number, dto: UpdateCostoCanteraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_costos_cantera')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteCostoCantera(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_costos_cantera').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Cobros ──────────────────────────────────────────────────
  async getCobros(query: CobrosQuery, token: string) {
    const supabase = createSupabaseClient(token)
    return fetchAll((from, to) => {
      let q = supabase
        .from('aridos_cobros')
        .select('*, aridos_clientes(nombre)')
        .order('fecha', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
      if (query.cliente_id) q = q.eq('cliente_id', query.cliente_id)
      return q
    })
  },

  async createCobro(dto: CreateCobroDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_cobros')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select('*, aridos_clientes(nombre)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async updateCobro(id: number, dto: UpdateCobroDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_cobros')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select('*, aridos_clientes(nombre)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deleteCobro(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_cobros').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Pagos a canteras y cuenta corriente del proveedor ────────
  async getPagosCantera(query: PagosCanteraQuery, token: string) {
    const supabase = createSupabaseClient(token)
    return fetchAll((from, to) => {
      let q = supabase
        .from('aridos_pagos_cantera')
        .select('*, aridos_canteras(nombre)')
        .order('fecha', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
      if (query.cantera_id) q = q.eq('cantera_id', query.cantera_id)
      return q
    })
  },

  async createPagoCantera(dto: CreatePagoCanteraDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('aridos_pagos_cantera')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select('*, aridos_canteras(nombre)')
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async deletePagoCantera(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('aridos_pagos_cantera').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // Cta cte con la cantera (proveedor): retirado = Σ costo_total de los
  // movimientos con cantera_id; saldo = retirado − pagos. Los retiros
  // sin costo cargado se cuentan aparte para avisar en la UI.
  async getCuentaCorrienteCanteras(token: string) {
    const supabase = createSupabaseClient(token)

    const movs = await fetchAll<{ cantera_id: number | null; costo_total: number | null }>(
      (from, to) => supabase
        .from('aridos_movimientos')
        .select('cantera_id, costo_total')
        .not('cantera_id', 'is', null)
        .order('id')
        .range(from, to)
    )
    const pagos = await fetchAll<{ cantera_id: number; monto: number }>(
      (from, to) => supabase
        .from('aridos_pagos_cantera')
        .select('cantera_id, monto')
        .order('id')
        .range(from, to)
    )
    const { data: canteras, error } = await supabase
      .from('aridos_canteras')
      .select('id, nombre, obs')
      .order('nombre')
    if (error) throw new Error(error.message)

    const retiradoPor = new Map<number, { total: number; retiros: number; sinCosto: number }>()
    for (const m of movs) {
      if (m.cantera_id == null) continue
      const acc = retiradoPor.get(m.cantera_id) ?? { total: 0, retiros: 0, sinCosto: 0 }
      acc.retiros += 1
      if (m.costo_total != null) acc.total += Number(m.costo_total)
      else acc.sinCosto += 1
      retiradoPor.set(m.cantera_id, acc)
    }
    const pagadoPor = new Map<number, number>()
    for (const p of pagos) {
      pagadoPor.set(p.cantera_id, (pagadoPor.get(p.cantera_id) ?? 0) + Number(p.monto))
    }

    return (canteras ?? []).map(c => {
      const r = retiradoPor.get(c.id) ?? { total: 0, retiros: 0, sinCosto: 0 }
      const pagado = pagadoPor.get(c.id) ?? 0
      return {
        id: c.id,
        nombre: c.nombre,
        obs: c.obs,
        retiros: r.retiros,
        retiros_sin_costo: r.sinCosto,
        retirado: r.total,
        pagado,
        saldo: r.total - pagado,
      }
    })
  },

  // ── Cuenta corriente ────────────────────────────────────────
  // Saldo por cliente = Σ importes de ventas − Σ cobros.
  // Mismo cálculo in-memory que alquiler.getCuentaCorriente.
  async getCuentaCorriente(token: string) {
    const supabase = createSupabaseClient(token)

    const ventas = await fetchAll<{ cliente_id: number; importe: number | null }>(
      (from, to) => supabase
        .from('aridos_movimientos')
        .select('cliente_id, importe')
        .eq('tipo', 'venta')
        .order('id')
        .range(from, to)
    )
    const cobros = await fetchAll<{ cliente_id: number; monto: number }>(
      (from, to) => supabase
        .from('aridos_cobros')
        .select('cliente_id, monto')
        .order('id')
        .range(from, to)
    )
    const { data: clientes, error } = await supabase
      .from('aridos_clientes')
      .select('id, nombre, cuit, tel')
      .order('nombre')
    if (error) throw new Error(error.message)

    const vendidoPor = new Map<number, number>()
    for (const v of ventas) {
      vendidoPor.set(v.cliente_id, (vendidoPor.get(v.cliente_id) ?? 0) + Number(v.importe ?? 0))
    }
    const cobradoPor = new Map<number, number>()
    for (const c of cobros) {
      cobradoPor.set(c.cliente_id, (cobradoPor.get(c.cliente_id) ?? 0) + Number(c.monto))
    }

    return (clientes ?? []).map(cl => {
      const vendido = vendidoPor.get(cl.id) ?? 0
      const cobrado = cobradoPor.get(cl.id) ?? 0
      return { ...cl, vendido, cobrado, saldo: vendido - cobrado }
    })
  },
}
