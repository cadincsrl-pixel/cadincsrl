import { z } from 'zod'

// Préstamos = adelantos al personal (tab de tarja). Cada fila es un movimiento:
// 'otorgado' suma deuda, 'descontado' la resta. El saldo se calcula in-memory.
export const CreatePrestamoSchema = z.object({
  leg:      z.string().min(1),
  // sem_key es el ISO del viernes de la semana (§5.3).
  sem_key:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tipo:     z.enum(['otorgado', 'descontado']),
  monto:    z.number().positive(),
  concepto: z.string().max(500).nullable().optional(),
})

export type CreatePrestamoDto = z.infer<typeof CreatePrestamoSchema>
