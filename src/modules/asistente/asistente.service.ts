// =====================================================================
// Asistente IA v1 — chat de SOLO LECTURA sobre los datos del ERP vía
// Claude API con tool use.
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
- Sos de solo lectura: no podés crear, modificar ni borrar nada, y no prometas hacerlo.
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

    const tools: Anthropic.Tool[] = ASISTENTE_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
    const runners = new Map(ASISTENTE_TOOLS.map(t => [t.name, t.run]))

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

    const ctx: ToolCtx = { userId, token, perfil }
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
              resultado = await run(tu.input, ctx)
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
