// =====================================================================
// Asistente IA — chat sobre los datos del ERP vía Claude API con tool use.
//
// Es de solo lectura CON UNA EXCEPCIÓN: puede cargar pedidos de compra
// dictados (asistente.pedidos.ts). Esa escritura no llama al service por
// dentro, sale por app.request() contra la ruta HTTP de siempre, así que
// hereda permiso, alcance por obra, validación y auditoría. Cualquier otra
// escritura que se agregue en el futuro tiene que seguir ese camino.
//
// Decisiones:
// - Loop MANUAL de tool use (client.messages.create, sin beta): control
//   explícito del tope de iteraciones, del tracking de herramientas_usadas
//   y sin depender del tool runner beta del SDK.
// - Prompt caching: cache_control ephemeral en el bloque ESTABLE del
//   system prompt → cachea tools + instrucciones (los tools van antes del
//   system en el prefijo). La fecha de hoy y el nombre del usuario van en
//   un segundo bloque SIN cache para no invalidar el prefijo.
// - Stateless: el frontend manda el historial completo en cada request.
// - Sin ANTHROPIC_API_KEY → AsistenteError 503 ASISTENTE_NO_CONFIGURADO,
//   sin instanciar el cliente (degrada limpio hasta que exista la key).
// =====================================================================
import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage } from './asistente.schema.js'
import { ASISTENTE_TOOLS, fetchPerfil, type ToolCtx } from './asistente.tools.js'
import { PEDIDO_TOOLS, type PedidoCtx } from './asistente.pedidos.js'

const MAX_ITER_HERRAMIENTAS = 8
const MAX_TOKENS = 2048

export class AsistenteError extends Error {
  constructor(public status: 400 | 403 | 500 | 502 | 503, public code: string) {
    super(code)
    this.name = 'AsistenteError'
  }
}

// Bloque estable del system prompt — NO meter acá nada volátil (fecha,
// nombre, ids): rompería el prompt caching en cada request.
const SYSTEM_ESTABLE = `Sos el asistente interno del ERP de CADINC SRL, una empresa argentina de construcción y logística. Respondés consultas de SOLO LECTURA sobre los datos del sistema usando las herramientas disponibles.

Reglas:
- Respondé en español rioplatense, conciso y directo. Andá al dato.
- La semana de tarja va de VIERNES a jueves (la clave de semana es el viernes). Nunca razones con semanas lunes-domingo.
- Formateá los montos en pesos argentinos estilo es-AR (ej.: $ 1.234.567,50). Las herramientas devuelven números crudos.
- NUNCA inventes números ni datos. Todo dato concreto debe salir de una herramienta. Si ninguna herramienta puede responder lo que piden, decilo claramente ("no tengo una herramienta para consultar eso").
- Si una herramienta devuelve { "error": "SIN_PERMISO" }, respondé que el usuario no tiene acceso a ese dato y NO intentes deducirlo ni conseguirlo por otra vía.
- Sos de solo lectura, con UNA excepción: podés cargar pedidos de compra. Nada más. No prometas editar ni borrar nada.

CÓMO CARGAR UN PEDIDO DICTADO
Alguien te va a decir algo como "para la garita 20 bolsas de cemento, 3 rollos de alambre y una masa". El objetivo es que quede cargado bien y en la menor cantidad de mensajes posible.

1. Buscá TODOS los materiales del dictado en UNA sola llamada a buscar_materiales. Nunca de a uno: es lento y se nota.
2. Juntá TODAS las dudas en UN SOLO mensaje. Esto es lo que separa un asistente de un formulario: no preguntes el cemento, esperes, y después preguntes el alambre. Preguntá las dos cosas juntas.
3. Cuando un material da varios candidatos, mostralos con lo que los DIFERENCIA (precio, medida, presentación), no solo el nombre. La persona elige por eso.
4. Si dijo una presentación que no es la de la ficha ("3 rollos de alambre" cuando el de atar va por kilo), decíselo y preguntá. NUNCA conviertas por tu cuenta: ahí es donde el precio termina mal por un factor de 20.
5. Lo que ya resolvió, resuelto. No vuelvas a preguntar algo que ya te contestó.
6. Antes de cargar, escribí el pedido completo —con el código de obra— y preguntá si lo cargás. Recién cuando dice que sí, llamás a crear_pedido pasándole su frase textual.
7. Después de cargar, decí el número de pedido y qué quedó a medias (renglones sin ficha del catálogo).

Avisos que cambian plata, decilos sin dramatizar, una línea:
- Si el material es una HERRAMIENTA: va al pañol y no se le factura a la obra.
- Si la obra es interna (pañol, mantenimiento, herreros, logística, poda): es gasto de CADINC, no se le cobra a ningún cliente.
- Si un material no está en el catálogo: se carga igual pero no cruza precio ni stock.

Reglas duras:
- Los material_id salen SOLO de buscar_materiales en ESTA conversación. Nunca de tu memoria, nunca inventados.
- Si no encontrás el material, no elijas el más parecido: decí que no está y ofrecé cargarlo sin catalogar, o preguntá.
- Un renglón sin material_id se rechaza si el catálogo tiene candidatos para ese texto. Mostráselos a la persona y mandá el id del que elija; sólo si te dice que ninguno es, repetís ese renglón con sin_ficha_confirmado: true.
- Las herramientas que no están en el catálogo NO se pueden crear desde el pedido: se dan de alta en Herramientas › Catálogo.
- Si crear_pedido te devuelve un error, contale a la persona qué pasó. No reintentes con otros valores por tu cuenta.
- No podés editar ni borrar un pedido ya cargado. Si se equivocaron, mandalos a la pantalla de Solicitudes.
- Si el pedido es ambiguo (qué obra, qué rango de fechas), preguntá o asumí lo razonable y aclaralo (ej.: "últimos 30 días").
- La fecha de hoy y el nombre del usuario que pregunta vienen a continuación de estas instrucciones.`

function fechaHoyAR(): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  }
  const legible = new Date().toLocaleDateString('es-AR', opts)
  const iso = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
  return `${legible} (${iso})`
}

export const asistenteService = {
  async chat(
    mensajes: ChatMessage[],
    userId: string,
    token: string,
  ): Promise<{ reply: string; herramientas_usadas: string[] }> {
    // Degradación limpia hasta que el dueño cargue la key.
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new AsistenteError(503, 'ASISTENTE_NO_CONFIGURADO')
    }

    const perfil = await fetchPerfil(userId)
    if (!perfil) throw new AsistenteError(403, 'SIN_PERFIL')

    const client = new Anthropic({
      timeout: 120_000,
      maxRetries: 1,
    })
    const model = process.env.ASISTENTE_MODEL ?? 'claude-sonnet-5'

    // Dos familias con reglas distintas: las de asistente.tools.ts son de
    // lectura; las de asistente.pedidos.ts escriben y reciben, además, los
    // mensajes del usuario (para verificar la confirmación server-side).
    const tools: Anthropic.Tool[] = [...ASISTENTE_TOOLS, ...PEDIDO_TOOLS].map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
    type Runner = (input: unknown, ctx: never) => Promise<unknown>
    const runners = new Map<string, Runner>()
    for (const t of ASISTENTE_TOOLS) runners.set(t.name, t.run as Runner)
    for (const t of PEDIDO_TOOLS)    runners.set(t.name, t.run as Runner)

    const system: Anthropic.TextBlockParam[] = [
      {
        type: 'text',
        text: SYSTEM_ESTABLE,
        // Cachea el prefijo completo (tools + este bloque). El bloque
        // siguiente es volátil y queda fuera del cache a propósito.
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: `HOY es ${fechaHoyAR()}, hora argentina (UTC-3).\nEl usuario que pregunta se llama ${perfil.nombre ?? 'Usuario sin nombre'}.`,
      },
    ]

    const ctxLectura: ToolCtx = { userId, token, perfil }
    // La confirmación del pedido se verifica contra los mensajes REALES del
    // usuario, no contra lo que el modelo diga que dijo.
    const ctxPedido: PedidoCtx = {
      userId, token, perfil,
      mensajesUsuario: mensajes.filter(m => m.role === 'user').map(m => m.content),
    }
    const esDePedidos = new Set(PEDIDO_TOOLS.map(t => t.name))
    const ctx = (nombre: string) => (esDePedidos.has(nombre) ? ctxPedido : ctxLectura) as never
    // La API exige que el primer mensaje sea role=user. Cuando el frontend
    // recorta el historial a una ventana fija, la ventana puede arrancar en
    // un assistant (a partir del intercambio 13) — dropeamos los assistant
    // iniciales para que la conversación nunca quede rota.
    const primerUser = mensajes.findIndex(m => m.role === 'user')
    const convo: Anthropic.MessageParam[] = mensajes.slice(primerUser).map(m => ({
      role: m.role,
      content: m.content,
    }))
    const usadas: string[] = []

    try {
      let iteraciones = 0
      while (true) {
        // Tras MAX_ITER llamadas de herramientas, forzamos respuesta final
        // (tool_choice none): el modelo cierra con lo que juntó hasta acá.
        const forzarFinal = iteraciones >= MAX_ITER_HERRAMIENTAS

        const response = await client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools,
          ...(forzarFinal ? { tool_choice: { type: 'none' as const } } : {}),
          messages: convo,
        })

        // Sin server tools no debería aparecer, pero por robustez: retomar,
        // con tope duro (comparte el contador — un pause_turn infinito no
        // puede colgar el request más allá de 2×MAX_ITER).
        if (response.stop_reason === 'pause_turn') {
          if (iteraciones >= MAX_ITER_HERRAMIENTAS * 2) {
            return {
              reply: 'La consulta se hizo demasiado larga y la corté. Probá con una pregunta más acotada.',
              herramientas_usadas: [...new Set(usadas)],
            }
          }
          convo.push({ role: 'assistant', content: response.content })
          iteraciones++
          continue
        }

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        )

        if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
          const reply = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim()
          if (!reply) {
            console.error(
              `[asistente] respuesta vacía — stop_reason=${response.stop_reason}, iteraciones=${iteraciones}, bloques=${response.content.map(b => b.type).join(',')}`,
            )
          }
          return {
            reply: reply || 'No pude generar una respuesta. Probá reformular la pregunta.',
            herramientas_usadas: [...new Set(usadas)],
          }
        }

        iteraciones++
        convo.push({ role: 'assistant', content: response.content })

        const results: Anthropic.ToolResultBlockParam[] = []
        for (const tu of toolUses) {
          usadas.push(tu.name)
          const run = runners.get(tu.name)
          let resultado: unknown
          if (!run) {
            resultado = { error: 'HERRAMIENTA_DESCONOCIDA', detalle: tu.name }
          } else {
            try {
              resultado = await run(tu.input, ctx(tu.name))
            } catch (err) {
              // Un fallo de datos NUNCA corta el chat: se le informa al
              // modelo como resultado y él decide cómo responder.
              const msg = err instanceof Error ? err.message : String(err)
              console.error(`[asistente] herramienta ${tu.name} falló:`, msg)
              resultado = { error: 'ERROR_HERRAMIENTA', detalle: msg }
            }
          }
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(resultado),
          })
        }
        convo.push({ role: 'user', content: results })
      }
    } catch (err) {
      if (err instanceof AsistenteError) throw err
      if (err instanceof Anthropic.AuthenticationError) {
        // Key presente pero inválida → mismo degradado que sin key.
        throw new AsistenteError(503, 'ASISTENTE_NO_CONFIGURADO')
      }
      if (err instanceof Anthropic.APIError) {
        console.error('[asistente] error de la API de Anthropic:', err.status, err.message)
        throw new AsistenteError(502, 'ERROR_PROVEEDOR_IA')
      }
      throw err
    }
  },
}
