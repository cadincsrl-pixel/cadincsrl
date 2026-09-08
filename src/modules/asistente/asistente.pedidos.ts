// =====================================================================
// Las dos herramientas con las que el asistente carga un pedido dictado.
//
// Están en su propio archivo porque son la EXCEPCIÓN a la regla del
// asistente: `crear_pedido` es lo único que escribe en la base. Todo lo
// demás (asistente.tools.ts) sigue siendo de solo lectura.
//
// Cómo se hace segura una escritura hecha por un modelo:
//
//  1. Entra por la puerta de siempre. `crear_pedido` no llama al service:
//     hace app.request('POST /api/solicitudes') con el Bearer del usuario.
//     Así hereda requirePermiso, requireTab, el alcance por obra, el zod y
//     el auditMiddleware sin duplicar una línea. Llamar al service por
//     dentro sería un bypass del permiso, que vive en la ruta.
//
//  2. El id de la ficha se re-verifica contra lo que dictó la persona.
//     Cada renglón viaja con `texto_dictado` verbatim y el servidor vuelve
//     a correr la búsqueda: si el material_id no está entre los candidatos
//     de ese texto, se rechaza. Es el candado contra el id alucinado, que
//     es el ÚNICO error de estos que resulta invisible — cantidad bien,
//     importe bien, solo la ficha mal, y se descubre semanas después.
//
//  3. La unidad no se pisa nunca en silencio. Si la que mandó el modelo no
//     es la de la ficha, se corta y se pregunta. Es el error que deja el
//     precio mal por un factor de 20 (las pinturas de esta semana).
//
//  4. La confirmación la verifica el servidor, no el prompt. `crear_pedido`
//     recibe la frase con la que la persona dijo que sí, y tiene que
//     aparecer en su ÚLTIMO mensaje, con al menos dos mensajes suyos en la
//     conversación. Un modelo entusiasta no puede cargar en el primer turno.
// =====================================================================
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { supabase } from '../../lib/supabase.js'
import { stockService, normMaterial } from '../stock/stock.service.js'
import { UNIDADES } from '../solicitudes/solicitudes.schema.js'
import type { Perfil } from './asistente.tools.js'

/** Contexto extra que estas dos necesitan y las de lectura no. */
export type PedidoCtx = {
  userId: string
  token: string
  perfil: Perfil
  /** Los mensajes del usuario en esta conversación, del más viejo al más nuevo. */
  mensajesUsuario: string[]
}

const esAdmin = (p: Perfil) => p.rol === 'admin'

function puedeCrearPedidos(p: Perfil): boolean {
  if (esAdmin(p)) return true
  if (p.permisos?.certificaciones?.creacion !== true) return false
  // Lista ausente o vacía = todas las tabs, igual que la UI y requireTab.
  const tabs = p.permisos?.certificaciones?.tabs
  if (!Array.isArray(tabs) || tabs.length === 0) return true
  return tabs.includes('solicitudes')
}

// ── buscar_materiales ─────────────────────────────────────────────────

const BuscarInput = z.object({
  consultas: z.array(z.object({
    texto: z.string().min(2).max(120)
      .describe('El material como lo dijo la persona, SIN la cantidad ni la presentación. "20 bolsas de cemento" → "cemento".'),
    unidad_dicha: z.string().max(30).nullish()
      .describe('La palabra de presentación tal cual la dijo: "bolsas", "rollos", "kilos". Null si no dijo ninguna.'),
    solo_herramientas: z.boolean().optional()
      .describe('true solo si la persona pidió explícitamente una herramienta.'),
  })).min(1).max(15),
})

async function buscarMateriales(input: unknown, ctx: PedidoCtx) {
  const { consultas } = input as z.infer<typeof BuscarInput>
  if (!puedeCrearPedidos(ctx.perfil)) {
    return { error: 'SIN_PERMISO' as const, detalle: 'No tiene permiso para cargar pedidos de compra.' }
  }
  const resultados = await stockService.buscarParaPedido(consultas, ctx.token)
  return { resultados }
}

// ── crear_pedido ──────────────────────────────────────────────────────

const CrearInput = z.object({
  obra_cod: z.string().min(1).describe('El código de la obra, no el nombre. Ej: "CC-025".'),
  confirmacion_del_usuario: z.string().min(1).max(300)
    .describe('La frase TEXTUAL con la que la persona dijo que sí después de ver el pedido completo. Ej: "dale".'),
  prioridad: z.enum(['normal', 'urgente']).optional(),
  obs: z.string().max(500).nullish().describe('Nota de cabecera, si la persona dijo algo que no es un renglón.'),
  items: z.array(z.object({
    texto_dictado: z.string().min(1).max(200)
      .describe('VERBATIM lo que dijo la persona para este renglón. Se usa para verificar que la ficha elegida se corresponda con lo dictado.'),
    descripcion: z.string().min(1).max(300),
    cantidad: z.number().positive(),
    unidad: z.enum(UNIDADES),
    material_id: z.number().int().positive().nullish()
      .describe('El id que devolvió buscar_materiales en ESTA conversación. Null si el material no está en el catálogo.'),
    sin_ficha_confirmado: z.boolean().optional()
      .describe('true SOLO si le mostraste los candidatos a la persona y dijo que ninguno es el que pide. Sin esto, un renglón sin material_id se rechaza cuando el catálogo tiene algo parecido.'),
    clase: z.enum(['material', 'herramienta']).optional(),
    color: z.string().max(60).nullish(),
    obs: z.string().max(300).nullish(),
  })).min(1).max(40),
})

/** Falla previsible: vuelve como resultado, con qué hacer, no como excepción. */
const rechazo = (code: string, detalle: string, extra: Record<string, unknown> = {}) =>
  ({ error: code, detalle, ...extra })

async function crearPedido(input: unknown, ctx: PedidoCtx) {
  const dto = input as z.infer<typeof CrearInput>

  if (!puedeCrearPedidos(ctx.perfil)) {
    return rechazo('SIN_PERMISO', 'No tiene permiso para cargar pedidos de compra.')
  }

  // (1) Confirmación de dos turnos, verificada acá y no confiada al prompt.
  const usuarios = ctx.mensajesUsuario
  if (usuarios.length < 2) {
    return rechazo('FALTA_CONFIRMACION',
      'Todavía no le mostraste el pedido a la persona. Escribile el resumen completo y esperá que confirme antes de llamar a esta herramienta.')
  }
  const ultimo = normMaterial(usuarios[usuarios.length - 1] ?? '')
  if (!ultimo.includes(normMaterial(dto.confirmacion_del_usuario))) {
    return rechazo('FALTA_CONFIRMACION',
      'La confirmación que mandaste no aparece en el último mensaje de la persona. No cargues el pedido hasta que diga que sí.')
  }

  // (2) La obra existe, está viva y el usuario la tiene en su alcance.
  const { data: obra } = await supabase
    .from('obras').select('cod, nom, archivada, es_interna, materiales_a_cargo_de')
    .eq('cod', dto.obra_cod).maybeSingle()
  if (!obra) return rechazo('OBRA_INEXISTENTE', `No existe la obra ${dto.obra_cod}. Preguntale a cuál.`)
  if (obra.archivada) return rechazo('OBRA_ARCHIVADA', `${obra.nom} está archivada: no se le pueden cargar pedidos.`)

  // (3) Las fichas mandan sobre el dictado: descripcion, clase y unidad salen
  //     del catálogo, no de lo que escribió el modelo.
  const ids = [...new Set(dto.items.map(i => i.material_id).filter((x): x is number => !!x))]
  const fichas = new Map<number, { nombre: string; unidad: string | null; clase: string | null; usa_color: boolean | null }>()
  if (ids.length) {
    const { data } = await supabase
      .from('stock_materiales').select('id, nombre, unidad, clase, usa_color, activo').in('id', ids)
    for (const f of data ?? []) {
      if (!f.activo) return rechazo('FICHA_DE_BAJA', `La ficha "${f.nombre}" está dada de baja. Buscá otra.`)
      fichas.set(f.id as number, f as never)
    }
    const faltan = ids.filter(id => !fichas.has(id))
    if (faltan.length) {
      return rechazo('MATERIAL_INEXISTENTE',
        `Estos material_id no existen: ${faltan.join(', ')}. Los ids salen SOLO de buscar_materiales en esta conversación; volvé a buscar.`)
    }
  }

  // (4) Coherencia texto↔ficha, en las DOS direcciones.
  //
  //     El id inventado ya estaba cubierto. Faltaba el simétrico, que es
  //     todavía más silencioso: el id AUSENTE. Un renglón con material_id
  //     null se salteaba todos los controles de catálogo —la re-búsqueda,
  //     la unidad, el pisado de la descripción—, así que un modelo que no
  //     llamara a buscar_materiales cargaba el pedido entero en texto libre
  //     con todas las guardias en verde. Y no se ve: como el modelo escribe
  //     bien la descripción, el renglón parece catalogado. Pasó de verdad
  //     con el pedido #697 (08/09/2026, el primero que cargó el asistente):
  //     seis renglones, los seis con ficha exacta en el catálogo, los seis
  //     sin vincular, y ninguno podía despacharse de depósito.
  //
  //     Ahora la búsqueda corre sobre TODOS los renglones: al que trae id
  //     se le exige que esté entre los candidatos, y al que no lo trae se
  //     le exige que la búsqueda no haya encontrado nada. El texto libre
  //     sigue siendo posible, pero deja de ser el camino sin control: o la
  //     búsqueda no devuelve nada, o la persona dijo que ninguno sirve
  //     (`sin_ficha_confirmado`), que es el mismo "no, es otro material"
  //     que ya usa `forzar` en el alta de materiales.
  const busquedas = await stockService.buscarParaPedido(
    dto.items.map(i => ({ texto: i.texto_dictado })), ctx.token)
  for (const [n, item] of dto.items.entries()) {
    const candidatos = busquedas[n]?.candidatos ?? []
    if (item.material_id) {
      if (!new Set(candidatos.map(c => c.material_id)).has(item.material_id)) {
        return rechazo('MATERIAL_NO_COINCIDE_CON_LO_DICTADO',
          `La ficha que elegiste para "${item.texto_dictado}" no aparece cuando busco ese texto. Volvé a buscarlo y preguntale a la persona cuál es.`,
          { texto: item.texto_dictado, candidatos })
      }
    } else if (candidatos.length && !item.sin_ficha_confirmado) {
      return rechazo('FALTA_ELEGIR_LA_FICHA',
        `"${item.texto_dictado}" SÍ tiene ficha en el catálogo y lo mandaste sin material_id. Mostrale estos candidatos a la persona y mandá el id del que elija. Si te dice que ninguno es, repetí el renglón con sin_ficha_confirmado: true.`,
        { texto: item.texto_dictado, candidatos })
    }
  }

  // (5) La unidad se pregunta, no se convierte ni se pisa.
  const items = dto.items.map(i => {
    const f = i.material_id ? fichas.get(i.material_id) : undefined
    return { ...i, ficha: f }
  })
  for (const i of items) {
    if (i.ficha && i.ficha.unidad && i.unidad !== i.ficha.unidad) {
      return rechazo('UNIDAD_DISTINTA_A_LA_FICHA',
        `"${i.ficha.nombre}" se lleva por ${i.ficha.unidad} y vos mandaste ${i.unidad}. NO reintentes con la unidad de la ficha sin preguntar: preguntale a la persona cuánto es en ${i.ficha.unidad}.`,
        { material: i.ficha.nombre, unidad_de_la_ficha: i.ficha.unidad, unidad_que_mandaste: i.unidad })
    }
    if (i.clase === 'herramienta' && !i.material_id) {
      return rechazo('HERRAMIENTA_SIN_FICHA',
        `"${i.descripcion}" es una herramienta y no está en el catálogo. Las herramientas se dan de alta en Herramientas › Catálogo, no desde el pedido. Decíselo y sacala del pedido.`)
    }
  }

  // (6) ¿Ya cargó esto hace un rato? Cubre el reintento por doble envío.
  const hace10min = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: recientes } = await supabase
    .from('solicitud_compra').select('id, created_at, solicitud_compra_item(id)')
    .eq('obra_cod', dto.obra_cod).eq('created_by', ctx.userId).gte('created_at', hace10min)
  const gemelo = (recientes ?? []).find(s =>
    (s.solicitud_compra_item as unknown[] | null)?.length === dto.items.length)
  if (gemelo) {
    return rechazo('POSIBLE_DUPLICADO',
      `Hace un rato se cargó el pedido #${gemelo.id} en esta misma obra, con la misma cantidad de renglones. Preguntale a la persona si es otro pedido antes de insistir.`,
      { solicitud_id: gemelo.id })
  }

  // (7) El POST de siempre, con el token del usuario.
  const { app } = await import('../../app.js')
  const cuerpo = {
    obra_cod:  dto.obra_cod,
    prioridad: dto.prioridad ?? 'normal',
    // El origen queda a la vista del comprador, sin migración: el `obs` de
    // cabecera arranca con [asistente] y sigue con lo que se dictó.
    obs: `[asistente] ${dto.obs ?? dto.items.map(i => i.texto_dictado).join(', ')}`.slice(0, 500),
    items: items.map(i => ({
      descripcion: i.ficha?.nombre ?? i.descripcion,
      cantidad:    i.cantidad,
      unidad:      i.ficha?.unidad ?? i.unidad,
      material_id: i.material_id ?? null,
      clase:       (i.ficha?.clase === 'herramienta' ? 'herramienta' : 'material'),
      color:       i.ficha?.usa_color ? (i.color ?? null) : null,
      obs:         i.obs ?? null,
    })),
  }

  const res = await app.request('/api/solicitudes', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${ctx.token}`,
    },
    body: JSON.stringify(cuerpo),
  })
  const json = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!res.ok) {
    return rechazo('NO_SE_PUDO_CARGAR',
      `El sistema rechazó el pedido (${res.status}). Contale a la persona qué pasó y no reintentes igual.`,
      { respuesta: json })
  }

  const creada = json as { id?: number } | null
  return {
    ok: true,
    solicitud_id: creada?.id ?? null,
    obra_cod: obra.cod,
    obra_nom: obra.nom,
    renglones: cuerpo.items.length,
    obra_interna: !!obra.es_interna,
    sin_catalogar: cuerpo.items.filter(i => !i.material_id).length,
  }
}

// ── Registro ──────────────────────────────────────────────────────────

export type PedidoTool = {
  name: string
  description: string
  input_schema: Anthropic.Tool.InputSchema
  run: (input: unknown, ctx: PedidoCtx) => Promise<unknown>
}

function jsonSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js['$schema']
  return js as Anthropic.Tool.InputSchema
}

/** Valida la entrada del modelo antes de correr: un input mal armado vuelve como texto, no como excepción. */
function conValidacion<T extends z.ZodType>(
  schema: T, fn: (input: unknown, ctx: PedidoCtx) => Promise<unknown>,
): (input: unknown, ctx: PedidoCtx) => Promise<unknown> {
  return async (input, ctx) => {
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      return { error: 'INPUT_INVALIDO', detalle: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
    }
    return fn(parsed.data, ctx)
  }
}

export const PEDIDO_TOOLS: PedidoTool[] = [
  {
    name: 'buscar_materiales',
    description:
      'Busca en el catálogo de CADINC los materiales que dictó la persona. Mandá TODOS los renglones del pedido en UNA sola llamada, nunca de a uno. No elige por vos: si un texto devuelve varios candidatos, mostráselos con lo que los diferencia (precio, medida, unidad) y preguntá cuál es.',
    input_schema: jsonSchema(BuscarInput),
    run: conValidacion(BuscarInput, buscarMateriales),
  },
  {
    name: 'crear_pedido',
    description:
      'Carga el pedido de compra en el sistema. Llamala SOLO después de haberle mostrado el pedido completo a la persona en un mensaje anterior y de que haya dicho que sí. El pedido cae directo en la cola de compras: no hay ningún paso de aprobación después.',
    input_schema: jsonSchema(CrearInput),
    run: conValidacion(CrearInput, crearPedido),
  },
]
