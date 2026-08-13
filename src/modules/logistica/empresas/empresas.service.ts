import { createSupabaseClient } from '../../../lib/supabase.js'
import { valorCambio } from '../../../lib/cambios.js'
import {
  normalizarTarifa, tarifaDelViaje, unidadDelCamion, fechaDeTarifa,
  type TarifaRow, type CamionRow,
} from './tarifa-resolucion.js'
import type {
  CreateEmpresaDto, UpdateEmpresaDto, CreateTarifaEmpresaDto,
  UpdateTarifaEmpresaDto, DeleteTarifaEmpresaDto,
} from './empresas.schema.js'

function codedError(code: string, message: string, detail?: unknown): Error {
  const e = new Error(message) as Error & { code?: string; detail?: unknown }
  e.code = code
  if (detail !== undefined) e.detail = detail
  return e
}

const money = (n: number) => '$' + n.toLocaleString('es-AR', { maximumFractionDigits: 2 })

/** Qué se le va a hacer a la tarifa. Determina contra qué escenario "después"
 *  se compara la resolución de cada viaje. */
type CambioTarifa =
  | { tipo: 'editar'; valor_ton?: number; vigente_desde?: string }
  | { tipo: 'eliminar' }
  // Alta con vigencia retroactiva: una tarifa nueva fechada hacia atrás gana la
  // escalera y repriecia todo lo ya cobrado desde esa fecha. Es el MISMO daño
  // que editar, por la puerta que el propio aviso recomienda ("crear versión
  // nueva"), así que también necesita barrera.
  | { tipo: 'crear' }

type FacturasAfectadas = { facturas: string[]; total: number; viajes: number }

/** Fila de `tramos` + su cobro. PostgREST devuelve el embed como objeto o como
 *  array de uno según la cardinalidad que infiere del schema; contemplamos los
 *  dos. */
type CobroDelViaje = { id: number; factura_nro: string | null }

type ViajeFacturado = {
  id:              number
  camion_id:       number | null
  deposito_id:     number | null
  tarifa_variante: string | null
  fecha_carga:     string | null
  fecha_descarga:  string | null
  cobro_id:        number | null
  cobros:          CobroDelViaje | CobroDelViaje[] | null
}

/** Facturas ya emitidas cuyo precio CAMBIA si se aplica `cambio` a la tarifa `t`.
 *
 *  No alcanza con filtrar por empresa+cantera+ventana de fechas: el precio de un
 *  viaje sale de una escalera de especificidad (depósito+unidad > depósito >
 *  unidad > general) que no se puede expresar en filtros de PostgREST. Con el
 *  filtro plano, editar la tarifa de chasis de Paramerica listaba 15 facturas
 *  cuando sólo 2 se habían facturado con ella — las otras 13 salieron con la
 *  tarifa de batea. Así que traemos las tarifas hermanas (mismo empresa+cantera)
 *  y los viajes facturados candidatos, y resolvemos viaje por viaje con el MISMO
 *  criterio que el desglose de FacturacionTab (ver tarifa-resolucion.ts).
 *
 *  Se cuenta un viaje si resuelve a esta tarifa ANTES o DESPUÉS del cambio:
 *   - editar precio          → mismo conjunto antes y después.
 *   - correr vigencia atrás  → la tarifa pasa a cubrir viajes que hoy se
 *                              facturaron con otra (esos también cambian).
 *   - correr vigencia adelante / eliminar → los viajes que hoy cubre pasan a
 *                              caer en otra tarifa (o en $0): también cambian.
 *  Por eso NO hace falta buscar la "versión siguiente" para acotar la ventana:
 *  la escalera ya la acota sola.
 *
 *  Un cobro cuenta como "factura emitida" si tiene `factura_nro` cargado. Los
 *  viajes cuelgan del cobro por `tramos.cobro_id`. */
async function facturasAfectadasPorTarifa(
  supabase: ReturnType<typeof createSupabaseClient>,
  t: TarifaRow,
  cambio: CambioTarifa,
): Promise<FacturasAfectadas> {
  // Toda la serie del par empresa+cantera: general, por depósito y por unidad.
  // Es un puñado de filas (una por versión de precio), no hace falta paginar.
  const { data: hermanasRaw, error: eTar } = await supabase
    .from('tarifas_empresa_cantera')
    .select('id, empresa_id, cantera_id, deposito_id, tipo_unidad, variante, valor_ton, vigente_desde')
    .eq('empresa_id', t.empresa_id)
    .eq('cantera_id', t.cantera_id)
  if (eTar) throw new Error(eTar.message)
  const antes = (hermanasRaw ?? []).map(normalizarTarifa)

  let despues: TarifaRow[]
  let piso = t.vigente_desde
  if (cambio.tipo === 'eliminar') {
    despues = antes.filter(x => x.id !== t.id)
  } else if (cambio.tipo === 'crear') {
    // `t` viene sintética (id sentinel): todavía no existe en la tabla, así que
    // no está entre las hermanas y sólo se agrega al escenario "después".
    despues = [...antes, t]
  } else {
    const editada: TarifaRow = {
      ...t,
      valor_ton:     cambio.valor_ton     ?? t.valor_ton,
      vigente_desde: cambio.vigente_desde ?? t.vigente_desde,
    }
    despues = antes.map(x => (x.id === t.id ? editada : x))
    // Si la vigencia se corre hacia atrás, la ventana a revisar arranca antes.
    if (editada.vigente_desde < piso) piso = editada.vigente_desde
  }

  // Candidatos: viajes facturados de ese empresa+cantera con fecha de tarifa
  // >= piso. Por debajo del piso ningún viaje puede resolver a esta tarifa (ni
  // antes ni después), así que recortar ahí es exacto, no una aproximación.
  // El filtro va sobre COALESCE(fecha_descarga, fecha_carga) — la misma fecha
  // con la que se resuelve el precio. `.or()` porque no hay columna para eso;
  // `fecha_operacion` NO sirve (es COALESCE(fecha_carga, fecha_vacio)).
  // "Ya cobrado" = el viaje está dentro de un cobro, con o sin número de
  // factura. Las empresas de modalidad `liquido_producto` NUNCA cargan
  // factura_nro (el frontend sólo lo manda si la empresa factura), así que
  // filtrar por ese campo dejaba fuera de la barrera 23 de los 52 cobros —
  // todos ya cobrados. El número se usa sólo para etiquetar el mensaje.
  const { data, error } = await supabase
    .from('tramos')
    .select('id, camion_id, deposito_id, tarifa_variante, fecha_carga, fecha_descarga, cobro_id, cobros!inner(id, factura_nro)')
    .eq('empresa_id', t.empresa_id)
    .eq('cantera_id', t.cantera_id)
    .not('cobro_id', 'is', null)
    .or(`fecha_descarga.gte.${piso},and(fecha_descarga.is.null,fecha_carga.gte.${piso})`)
  if (error) throw new Error(error.message)

  const filas = (data ?? []) as unknown as ViajeFacturado[]
  if (filas.length === 0) return { facturas: [], total: 0, viajes: 0 }

  // La unidad (batea/chasis) sale de la categoría del camión. Son ~6 filas.
  const { data: camiones, error: eCam } = await supabase.from('camiones').select('id, categoria')
  if (eCam) throw new Error(eCam.message)

  // Varios viajes pueden colgar del mismo cobro → una sola entrada.
  const nros = new Set<string>()
  let viajes = 0
  for (const row of filas) {
    const fecha  = fechaDeTarifa(row)
    const unidad = unidadDelCamion((camiones ?? []) as CamionRow[], row.camion_id)
    const dep    = row.deposito_id == null ? null : Number(row.deposito_id)
    const varnt  = row.tarifa_variante ?? null
    const resAntes   = tarifaDelViaje(antes,   t.empresa_id, t.cantera_id, dep, fecha, unidad, varnt)
    const resDespues = tarifaDelViaje(despues, t.empresa_id, t.cantera_id, dep, fecha, unidad, varnt)

    // Lo que importa no es si la tarifa que se toca es la que resuelve, sino
    // si al viaje le CAMBIA el precio aplicado. Sin esto, mover sólo la
    // vigencia (sin tocar el valor) listaba todos los viajes que la tarifa ya
    // cubría y seguía cubriendo: alertas de 15 facturas donde no cambia nada,
    // que es justo lo que entrena a confirmar sin leer.
    const antesVal   = Number(resAntes?.valor_ton   ?? 0)
    const despuesVal = Number(resDespues?.valor_ton ?? 0)
    if (antesVal === despuesVal) continue

    viajes++
    const cobro = Array.isArray(row.cobros) ? row.cobros[0] : row.cobros
    // Sin número de factura (líquido producto) se identifica por el cobro.
    nros.add(cobro?.factura_nro?.trim() || `Cobro #${cobro?.id ?? row.cobro_id}`)
  }

  const facturas = [...nros].sort()
  return { facturas, total: facturas.length, viajes }
}

/** Lee la tarifa para los guards. 404 si no existe. */
async function traerTarifa(
  supabase: ReturnType<typeof createSupabaseClient>,
  id: number,
): Promise<TarifaRow> {
  const { data, error } = await supabase
    .from('tarifas_empresa_cantera')
    .select('id, empresa_id, cantera_id, deposito_id, tipo_unidad, variante, valor_ton, vigente_desde')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw codedError('TARIFA_NO_EXISTE', 'Tarifa no encontrada')
  return normalizarTarifa(data)
}

/** "1178, 1183" / "1178, 1183 y 3 más" — máximo 5 números en el mensaje. */
function listarFacturas(facturas: string[]): { muestra: string[]; listado: string } {
  const muestra = facturas.slice(0, 5)
  const resto   = facturas.length - muestra.length
  return { muestra, listado: muestra.join(', ') + (resto > 0 ? ` y ${resto} más` : '') }
}

export const empresasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('empresas_transportistas')
      .select('*')
      .order('nombre')
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('empresas_transportistas')
      .insert({ ...dto, created_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('empresas_transportistas')
      .update({ ...dto, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('empresas_transportistas').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Tarifas históricas por empresa × cantera ──

  async getTarifas(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .select('*, empresas_transportistas(nombre), canteras(nombre, localidad), depositos(nombre, localidad)')
      .order('empresa_id')
      .order('cantera_id')
      .order('vigente_desde', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async createTarifa(dto: CreateTarifaEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { confirmar_pisar_historico, ...campos } = dto as CreateTarifaEmpresaDto & {
      confirmar_pisar_historico?: boolean
    }

    // Un alta con vigencia retroactiva repriecia lo ya cobrado igual que una
    // edición. Se compara con una fila sintética (id sentinel, nunca choca con
    // una hermana real).
    if (!confirmar_pisar_historico) {
      const nueva: TarifaRow = {
        id:            -1,
        empresa_id:    campos.empresa_id,
        cantera_id:    campos.cantera_id,
        deposito_id:   campos.deposito_id ?? null,
        tipo_unidad:   campos.tipo_unidad ?? null,
        variante:      campos.variante ?? null,
        valor_ton:     Number(campos.valor_ton),
        vigente_desde: campos.vigente_desde,
      }
      const afectadas = await facturasAfectadasPorTarifa(supabase, nueva, { tipo: 'crear' })
      if (afectadas.total > 0) {
        throw codedError(
          'TARIFA_YA_FACTURADA',
          `Esta tarifa rige desde el ${campos.vigente_desde} y con eso cambia el precio de ${afectadas.total} cobro${afectadas.total !== 1 ? 's' : ''} ya emitido${afectadas.total !== 1 ? 's' : ''}.`,
          {
            operacion: 'crear',
            cantidad:  afectadas.total,
            viajes:    afectadas.viajes,
            facturas:  afectadas.facturas.slice(0, 5),
            vigente_desde_nuevo: campos.vigente_desde,
            valor_nuevo:         Number(campos.valor_ton),
          },
        )
      }
    }

    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .insert({ ...campos, updated_by: userId, updated_at: new Date().toISOString() })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Editar precio o fecha de vigencia REESCRIBE el precio histórico: los cobros
  // ya facturados con esa tarifa dejan de coincidir con lo que dice el sistema.
  // Pasó el 27/07/2026 — una tarifa de LARTIRIGOYEN se editó de $96.800 a
  // $102.850 dejando la misma vigencia, y las facturas 1178 y 1183 (emitidas a
  // 96.800) quedaron descalzadas. Lo correcto cuando cambia el precio es crear
  // una versión nueva con la fecha del cambio; la tabla está versionada por
  // `vigente_desde` justamente para eso. Se corrige igual sólo con
  // `confirmar_pisar_historico: true` (caso legítimo: precio mal tipeado).
  async updateTarifa(id: number, dto: UpdateTarifaEmpresaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    // El flag es una confirmación de la operación, no un campo del registro.
    const { confirmar_pisar_historico, ...patch } = dto

    // Cambiar sólo la observación no toca plata.
    const tocaPlata = patch.valor_ton !== undefined || patch.vigente_desde !== undefined
    if (tocaPlata && !confirmar_pisar_historico) {
      const t = await traerTarifa(supabase, id)
      // El form manda el registro completo: sólo cuenta lo que cambió de valor.
      const cambioValor = patch.valor_ton !== undefined && valorCambio(patch.valor_ton, t.valor_ton)
      const cambioDesde = patch.vigente_desde !== undefined && valorCambio(patch.vigente_desde, t.vigente_desde)

      if (cambioValor || cambioDesde) {
        // Se evalúa la tarifa como QUEDARÍA, no sólo como está: correr la
        // vigencia hacia atrás la hace cubrir un período ya facturado con otro
        // precio, y con la ventana vieja eso daba 0 facturas.
        const { facturas, viajes } = await facturasAfectadasPorTarifa(supabase, t, {
          tipo:          'editar',
          valor_ton:     cambioValor ? patch.valor_ton : undefined,
          vigente_desde: cambioDesde ? patch.vigente_desde : undefined,
        })
        if (facturas.length > 0) {
          const { muestra, listado } = listarFacturas(facturas)
          const queCambia = cambioValor
            ? `de ${money(t.valor_ton)} a ${money(Number(patch.valor_ton))} por tonelada`
            : `la vigencia del ${t.vigente_desde} al ${patch.vigente_desde}`
          const emitidas = facturas.length === 1
            ? 'ya se emitió 1 factura'
            : `ya se emitieron ${facturas.length} facturas`
          throw codedError(
            'TARIFA_YA_FACTURADA',
            `Con esta tarifa ${emitidas}: ${listado}. ` +
            `Cambiarla ${queCambia} reescribe el precio histórico y esas facturas dejan de coincidir con el sistema. ` +
            `Si el precio cambió a partir de una fecha, cerrá esto y cargá una tarifa nueva con esa fecha ("Nueva tarifa"): ` +
            `la vieja queda como está y los viajes anteriores se siguen facturando al precio de entonces.`,
            {
              operacion:            'editar',
              cantidad:             facturas.length,
              facturas:             muestra,
              viajes,
              valor_actual:         t.valor_ton,
              valor_nuevo:          patch.valor_ton !== undefined ? Number(patch.valor_ton) : null,
              vigente_desde_actual: t.vigente_desde,
              vigente_desde_nuevo:  patch.vigente_desde ?? null,
            },
          )
        }
      }
    }

    const { data, error } = await supabase
      .from('tarifas_empresa_cantera')
      .update({ ...patch, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Borrar es PEOR que pisar el precio: las facturas emitidas quedan sin tarifa
  // que las explique y el desglose las muestra a $0/ton. El botón 🗑 está a dos
  // centímetros del que devuelve el 409 al editar, así que tiene que frenar por
  // el mismo motivo y con el mismo código de error.
  async deleteTarifa(id: number, dto: DeleteTarifaEmpresaDto, token: string) {
    const supabase = createSupabaseClient(token)

    if (!dto.confirmar_pisar_historico) {
      const t = await traerTarifa(supabase, id)
      const { facturas, viajes } = await facturasAfectadasPorTarifa(supabase, t, { tipo: 'eliminar' })
      if (facturas.length > 0) {
        const { muestra, listado } = listarFacturas(facturas)
        const emitidas = facturas.length === 1
          ? 'ya se emitió 1 factura'
          : `ya se emitieron ${facturas.length} facturas`
        const esos = viajes === 1 ? 'ese viaje' : `esos ${viajes} viajes`
        throw codedError(
          'TARIFA_YA_FACTURADA',
          `Con esta tarifa ${emitidas}: ${listado}. ` +
          `Si la borrás, ${esos} se quedan sin precio y el detalle del cobro los va a mostrar a $0 por tonelada. ` +
          `Si lo que querés es cambiar el precio, cerrá esto y cargá una tarifa nueva con la fecha desde la que rige ` +
          `("Nueva tarifa"): la de ${money(t.valor_ton)} queda como histórico y las facturas ya emitidas se siguen explicando solas.`,
          {
            operacion:            'eliminar',
            cantidad:             facturas.length,
            facturas:             muestra,
            viajes,
            valor_actual:         t.valor_ton,
            valor_nuevo:          null,
            vigente_desde_actual: t.vigente_desde,
            vigente_desde_nuevo:  null,
          },
        )
      }
    }

    const { error } = await supabase.from('tarifas_empresa_cantera').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
