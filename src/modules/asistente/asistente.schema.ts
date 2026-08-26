import { z } from 'zod'

// Contrato fijo del Asistente IA (v1):
// POST /api/asistente/chat
// Body: { messages: [{ role: 'user'|'assistant', content: string }] }
//   - máx 24 mensajes (el backend es stateless: el front manda TODO el
//     historial en cada request).
//   - el último mensaje debe ser role='user' con content de máx 2000 chars.
// Los mensajes assistant del historial son respuestas previas nuestras y
// pueden superar los 2000 chars (max_tokens 2048 ≈ ~8000 chars) — se les da
// un techo generoso para cortar abusos sin romper conversaciones legítimas.

export const ChatMessageSchema = z.object({
  role:    z.enum(['user', 'assistant']),
  content: z.string().min(1).max(10_000),
})

export const ChatBodySchema = z
  .object({
    messages: z.array(ChatMessageSchema).min(1).max(24),
  })
  .superRefine((body, ctx) => {
    const last = body.messages[body.messages.length - 1]
    if (!last) return
    if (last.role !== 'user') {
      ctx.addIssue({
        code: 'custom',
        path: ['messages', body.messages.length - 1, 'role'],
        message: 'El último mensaje debe ser role=user',
      })
      return
    }
    if (last.content.length > 2000) {
      ctx.addIssue({
        code: 'custom',
        path: ['messages', body.messages.length - 1, 'content'],
        message: 'El mensaje del usuario no puede superar 2000 caracteres',
      })
    }
  })

export type ChatBody = z.infer<typeof ChatBodySchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
