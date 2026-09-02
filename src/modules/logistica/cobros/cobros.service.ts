import { createSupabaseClient } from '../../../lib/supabase.js'
import {
  normalizarTarifa, tarifaDelViaje, unidadDelCamion, fechaDeTarifa,
} from '../empresas/tarifa-resolucion.js'
import type { CreateCobroDto, ContraFacturaDto } from './cobros.schema.js'

function codedError(code: string, message: string, detail?: unknown): Error {
  const e = new Error(message) as Error & { code?: string; detail?: unknown }
  e.code = code
  if (detail !== undefined) e.detail = detail
  return e
}

// `cobros.contra_factura_nro/_fecha` + los tipos de adjuntos y el flag
// `contra_factura` de la empresa viajan en el mismo shape que consume la
// grilla de facturación. Se comparte entre getAll y el PATCH de contra
// factura para que la respuesta del PATCH sea drop-in en la cache del cliente.
const COBRO_SELECT =
  '*, empresas_transportistas(nombre, modalidad_cobro, contra_factura), cobros_adjuntos(tipo, deleted_at, hash_sha256)'

const money = (n: number) => '$' + n.toLocaleString('es-AR', { maximumFractionDigits: 2 })

/** Etiqueta legible de un viaje para los mensajes de error: nº de remito si
 *  lo tiene (es lo que el usuario ve en la grilla), sino el id. */
function etiquetaViaje(t: { id: number; remito_carga?: string | null; remito_descarga?: string | null }): string {
  const remito = (t.remito_carga ?? '').trim() || (t.remito_descarga ?? '').trim()
  return remito ? `remito ${remito} (viaje #${t.id})` : `viaje #${t.id}`
}

export const cobrosService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cobros')
      // Los tipos de adjuntos embebidos permiten al frontend mostrar qué
      // documentos tiene cada cobro (PDF factura / liquidación / comprobante)
      // sin una query por fila. El hash del comprobante deja agrupar en el
      // historial las facturas pagadas juntas (mismo comprobante = mismo pago).
      .select(COBRO_SELECT)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateCobroDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // 0. Si la empresa cobra con facturación, el cobro ES una factura emitida
    // por CADINC: exige nº + fecha de factura y al menos un viaje. Una misma
    // factura puede cubrir varios viajes (2026-08-20; antes era 1 a 1).
    const { data: empresa, error: errEmp } = await supabase
      .from('empresas_transportistas')
      .select('modalidad_cobro')
      .eq('id', dto.empresa_id)
      .maybeSingle()
    if (errEmp) throw new Error(errEmp.message)
    if (!empresa) {
      const e = new Error('EMPRESA_NO_EXISTE') as Error & { code?: string }
      e.code = 'EMPRESA_NO_EXISTE'
      throw e
    }
    const esFacturacion = empresa.modalidad_cobro === 'facturacion'
    if (esFacturacion) {
      if (!dto.factura_nro?.trim() || !dto.factura_fecha) {
        const e = new Error('FALTA_FACTURA') as Error & { code?: string }
        e.code = 'FALTA_FACTURA'
        throw e
      }
      if (!dto.tramo_ids || dto.tramo_ids.length < 1) {
        const e = new Error('FACTURA_SIN_VIAJES') as Error & { code?: string }
        e.code = 'FACTURA_SIN_VIAJES'
        throw e
      }
    }

    // 1. Validar tramos ANTES de crear el cobro (evita huérfanos): que existan,
    // pertenezcan a la empresa del cobro y no estén ya cobrados.
    if (dto.tramo_ids && dto.tramo_ids.length > 0) {
      const { data: tramos, error: errVal } = await supabase
        .from('tramos')
        .select('id, empresa_id, cobro_id')
        .in('id', dto.tramo_ids)
      if (errVal) throw new Error(errVal.message)
      if (!tramos || tramos.length !== dto.tramo_ids.length) {
        const e = new Error('TRAMO_NO_EXISTE') as Error & { code?: string }
        e.code = 'TRAMO_NO_EXISTE'
        throw e
      }
      const otraEmpresa = tramos.filter(t => t.empresa_id !== dto.empresa_id)
      if (otraEmpresa.length > 0) {
        const e = new Error('TRAMO_OTRA_EMPRESA') as Error & { code?: string; detail?: number[] }
        e.code = 'TRAMO_OTRA_EMPRESA'
        e.detail = otraEmpresa.map(t => t.id)
        throw e
      }
      const yaCobrados = tramos.filter(t => t.cobro_id != null)
      if (yaCobrados.length > 0) {
        const e = new Error('TRAMO_YA_COBRADO') as Error & { code?: string; detail?: number[] }
        e.code = 'TRAMO_YA_COBRADO'
        e.detail = yaCobrados.map(t => t.id)
        throw e
      }
    }

    // 2. Crear el cobro
    const { data: cobro, error: errCobro } = await supabase
      .from('cobros')
      .insert({
        empresa_id:        dto.empresa_id,
        fecha_desde:       dto.fecha_desde,
        fecha_hasta:       dto.fecha_hasta,
        toneladas_totales: dto.toneladas_totales,
        total:             dto.total,
        obs:               dto.obs,
        factura_nro:       esFacturacion ? dto.factura_nro!.trim() : null,
        factura_fecha:     esFacturacion ? dto.factura_fecha : null,
        estado:            'pendiente',
        created_by:        userId,
      })
      .select()
      .single()
    if (errCobro) throw new Error(errCobro.message)

    // 3. Marcar tramos con cobro_id. Si falla, borrar el cobro recién creado
    // (best-effort, sin RPC no es transaccional pero evita el huérfano típico).
    if (dto.tramo_ids && dto.tramo_ids.length > 0) {
      const { error: errTramos } = await supabase
        .from('tramos')
        .update({ cobro_id: cobro.id })
        .in('id', dto.tramo_ids)
      if (errTramos) {
        await supabase.from('cobros').delete().eq('id', cobro.id)
        throw new Error(errTramos.message)
      }
    }

    return cobro
  },

  async marcarCobrado(id: number, token: string, userId: string, fechaCobro?: string) {
    const supabase = createSupabaseClient(token)

    // Validar que exista comprobante de pago antes de marcar como cobrado.
    // Sin comprobante no hay forma de demostrar el pago — y el user
    // pidió que el sistema lo bloquee para evitar olvidos.
    const { data: adjs, error: errAdj } = await supabase
      .from('cobros_adjuntos')
      .select('id')
      .eq('cobro_id', id)
      .eq('tipo', 'comprobante')
      .is('deleted_at', null)
      .limit(1)
    if (errAdj) throw new Error(errAdj.message)
    if (!adjs || adjs.length === 0) {
      const e = new Error('FALTA_COMPROBANTE_PAGO') as Error & { code?: string }
      e.code = 'FALTA_COMPROBANTE_PAGO'
      throw e
    }

    const update: Record<string, unknown> = {
      estado: 'cobrado', updated_by: userId, updated_at: new Date().toISOString(),
      // Fecha real del cobro (columna propia desde 20260806); sin fecha del
      // modal cae a hoy. La nota en obs se mantiene por compatibilidad con
      // PDFs/exports que la leen.
      cobrado_en: fechaCobro ?? new Date().toISOString().slice(0, 10),
    }
    if (fechaCobro) {
      const { data: actual, error: errObs } = await supabase
        .from('cobros').select('obs').eq('id', id).maybeSingle()
      if (errObs) throw new Error(errObs.message)
      const [y, m, d] = fechaCobro.split('-')
      const nota = `Cobrado el ${d}/${m}/${y}`
      const obsActual = (actual?.obs ?? '').trim()
      // No duplicar la nota si ya la tiene (retry o doble click).
      update.obs = obsActual.includes(nota) ? obsActual : [obsActual, nota].filter(Boolean).join(' · ')
    }

    const { data, error } = await supabase
      .from('cobros')
      .update(update)
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  // Volver un cobro de 'cobrado' a 'pendiente' — útil cuando se marcó
  // por error o falta corregir el comprobante.
  async revertirCobrado(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('cobros')
      .update({ estado: 'pendiente', cobrado_en: null, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  /** Carga (o corrige) la contra factura del intermediario sobre una factura ya
   *  emitida: nº + fecha del documento en el cobro, y el importe por viaje en
   *  `tramos.comision_intermediario`.
   *
   *  Se escribe desde ACÁ y no por PATCH /tramos/:id a propósito: los tramos
   *  cobrados están congelados (TRAMO_COBRADO en tramos.service) porque su
   *  precio ya se facturó. La comisión no cambia lo facturado — es un dato del
   *  cobro que se aplica a nivel viaje —, así que el dueño del dato es el cobro.
   *
   *  NO se bloquea por estado del cobro: la contra factura llega DESPUÉS de la
   *  factura y muchas veces después de que la plata entró (cobro `cobrado`).
   *  Exigir revertir el cobro para cargarla sería inventar un paso que en la
   *  operación real no existe. */
  async actualizarContraFactura(id: number, dto: ContraFacturaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)

    // 1. El cobro tiene que existir.
    const { data: cobro, error: errCobro } = await supabase
      .from('cobros')
      .select('id, empresa_id, estado')
      .eq('id', id)
      .maybeSingle()
    if (errCobro) throw new Error(errCobro.message)
    if (!cobro) throw codedError('COBRO_NO_EXISTE', 'La factura no existe o fue eliminada.')

    // 2. Sólo las empresas marcadas como intermediarias contra facturan. Si no,
    // el dato no significa nada y se estaría ensuciando la base del chofer.
    const { data: empresa, error: errEmp } = await supabase
      .from('empresas_transportistas')
      .select('id, nombre, contra_factura')
      .eq('id', cobro.empresa_id)
      .maybeSingle()
    if (errEmp) throw new Error(errEmp.message)
    if (!empresa) throw codedError('EMPRESA_NO_EXISTE', 'La empresa de la factura no existe.')
    if (empresa.contra_factura !== true) {
      throw codedError(
        'EMPRESA_SIN_CONTRA_FACTURA',
        `${empresa.nombre ?? 'La empresa'} no está marcada como intermediaria, así que no emite contra factura. Activá "Contra factura" en la ficha de la empresa si corresponde.`,
      )
    }

    const comisiones = dto.comisiones ?? []

    if (comisiones.length > 0) {
      const ids = [...new Set(comisiones.map(x => x.tramo_id))]

      // 3. Todos los viajes tienen que colgar de ESTA factura. Un viaje de otra
      // factura (o suelto) con comisión rompería el neto del chofer sin que
      // nadie lo vea desde acá.
      const { data: tramosRaw, error: errTramos } = await supabase
        .from('tramos')
        .select('id, cobro_id, empresa_id, camion_id, cantera_id, deposito_id, tarifa_variante, fecha_carga, fecha_descarga, toneladas_carga, toneladas_descarga, remito_carga, remito_descarga')
        .in('id', ids)
      if (errTramos) throw new Error(errTramos.message)
      const tramos = tramosRaw ?? []
      const ajenos = ids.filter(tid => {
        const t = tramos.find(x => Number(x.id) === tid)
        return !t || Number(t.cobro_id) !== id
      })
      if (ajenos.length > 0) {
        throw codedError(
          'TRAMO_NO_ES_DEL_COBRO',
          `Estos viajes no pertenecen a la factura: ${ajenos.join(', ')}. Recargá la pantalla — la factura pudo cambiar de viajes.`,
          ajenos,
        )
      }

      // 4. La comisión no puede superar lo facturado por ese viaje. El bruto se
      // resuelve con el MISMO criterio que el desglose de facturación
      // (ton descarga → carga × tarifa vigente, valor_ton ya con IVA), así que
      // no hace falta convertir nada: comisión y bruto están ambos con IVA.
      const conMonto = comisiones.filter(x => x.monto != null)
      if (conMonto.length > 0) {
        const [{ data: tarifasRaw, error: eTar }, { data: camionesRaw, error: eCam }] = await Promise.all([
          supabase
            .from('tarifas_empresa_cantera')
            .select('id, empresa_id, cantera_id, deposito_id, tipo_unidad, variante, valor_ton, vigente_desde')
            .eq('empresa_id', cobro.empresa_id),
          supabase.from('camiones').select('id, categoria'),
        ])
        if (eTar) throw new Error(eTar.message)
        if (eCam) throw new Error(eCam.message)
        const tarifas  = (tarifasRaw ?? []).map(normalizarTarifa)
        const camiones = (camionesRaw ?? []).map(c => ({ id: Number(c.id), categoria: (c.categoria ?? null) as string | null }))

        for (const item of conMonto) {
          const monto = Number(item.monto)
          const t = tramos.find(x => Number(x.id) === item.tramo_id)!
          const ton = Number(t.toneladas_descarga ?? t.toneladas_carga ?? 0)
          const tarifa = tarifaDelViaje(
            tarifas,
            Number(t.empresa_id),
            t.cantera_id == null ? null : Number(t.cantera_id),
            t.deposito_id == null ? null : Number(t.deposito_id),
            fechaDeTarifa(t),
            unidadDelCamion(camiones, t.camion_id == null ? null : Number(t.camion_id)),
            (t.tarifa_variante ?? null) as string | null,
          )
          const bruto = ton * (tarifa?.valor_ton ?? 0)
          // Redondeo: los numeric de PostgREST llegan como string y el frontend
          // manda floats; 1 centavo de tolerancia evita falsos rechazos.
          if (monto > bruto + 0.01) {
            const porQue = bruto === 0
              ? 'ese viaje no tiene tarifa vigente o toneladas cargadas, así que su bruto facturado es $0'
              : `el bruto facturado de ese viaje es ${money(bruto)}`
            throw codedError(
              'COMISION_MAYOR_QUE_VIAJE',
              `La comisión de ${money(monto)} supera lo facturado en ${etiquetaViaje(t)}: ${porQue}. Corregí el monto (o revisá la tarifa del viaje).`,
              { tramo_id: t.id, monto, bruto },
            )
          }
        }
      }

      // 5. Escribir. Se agrupa por monto para no hacer un UPDATE por viaje
      // (una factura puede llevar decenas). `null` borra la comisión.
      const porMonto = new Map<number | null, number[]>()
      for (const x of comisiones) {
        const k = x.monto == null ? null : Number(x.monto)
        porMonto.set(k, [...(porMonto.get(k) ?? []), x.tramo_id])
      }
      for (const [monto, tramoIds] of porMonto) {
        const { error } = await supabase
          .from('tramos')
          .update({ comision_intermediario: monto, updated_by: userId })
          .in('id', tramoIds)
        if (error) throw new Error(error.message)
      }
    }

    // 6. El documento en sí. String vacío se normaliza a null: "sin número"
    // tiene que ser NULL para que los filtros y los avisos del frontend no
    // vean una contra factura fantasma.
    const nro = dto.contra_factura_nro?.trim()
    const { error: errUpd } = await supabase
      .from('cobros')
      .update({
        contra_factura_nro:   nro ? nro : null,
        contra_factura_fecha: dto.contra_factura_fecha ?? null,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (errUpd) throw new Error(errUpd.message)

    // Devolver el cobro con el mismo shape que GET / (embeds incluidos).
    const { data, error } = await supabase
      .from('cobros')
      .select(COBRO_SELECT)
      .eq('id', id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    // Bloquear delete si el cobro ya está cobrado: borrarlo perdería el
    // rastro de plata efectivamente entrada y liberaría tramos ya facturados.
    const { data: cobro, error: errSel } = await supabase
      .from('cobros').select('estado').eq('id', id).maybeSingle()
    if (errSel) throw new Error(errSel.message)
    if (!cobro) {
      const e = new Error('COBRO_NO_EXISTE') as Error & { code?: string }
      e.code = 'COBRO_NO_EXISTE'
      throw e
    }
    if (cobro.estado === 'cobrado') {
      const e = new Error('COBRO_YA_COBRADO') as Error & { code?: string }
      e.code = 'COBRO_YA_COBRADO'
      throw e
    }
    // Liberar tramos y borrar. La comisión del intermediario también se limpia:
    // la contra factura era la comisión SOBRE ESTA factura, así que si la
    // factura desaparece el monto deja de tener referencia. Arrastrarlo a la
    // próxima factura le restaría plata al chofer en silencio.
    await supabase.from('tramos')
      .update({ cobro_id: null, comision_intermediario: null })
      .eq('cobro_id', id)
    const { error } = await supabase.from('cobros').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  },
}
