/**
 * Tests del aviso en vivo de cambios en pedidos (17/09).
 *
 * Lo que se cuida acá es que el middleware NO avise cuando no corresponde,
 * porque cada aviso le cuesta a cada pantalla abierta un refresco de ~400 KB
 * contra Render — el gasto que este mecanismo existe para evitar. Y que el
 * payload siga vacío: el canal es público, así que un dato que se cuele ahí lo
 * puede leer cualquiera con la anon key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { realtimeMiddleware, _resetThrottle, TOPICO_CAMBIOS } from '../../src/middleware/realtime.js'

const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))

function ctx(method: string, url: string, status = 200) {
  return { req: { method, url }, res: { status } } as any
}
const siguiente = async () => {}

describe('realtimeMiddleware: cuándo avisa', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    fetchMock.mockClear()
    _resetThrottle()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('avisa cuando se resuelve un renglón', async () => {
    await realtimeMiddleware(ctx('POST', 'http://x/api/solicitudes/items/1/comprar'), siguiente)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('avisa cuando se emite un remito de envío, que es lo que pasa a enviado', async () => {
    await realtimeMiddleware(ctx('POST', 'http://x/api/remitos-envio'), siguiente)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('NO avisa en un GET', async () => {
    await realtimeMiddleware(ctx('GET', 'http://x/api/solicitudes'), siguiente)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('NO avisa si el handler falló', async () => {
    await realtimeMiddleware(ctx('POST', 'http://x/api/solicitudes', 403), siguiente)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('NO avisa por rutas de otros módulos', async () => {
    await realtimeMiddleware(ctx('PUT', 'http://x/api/horas'), siguiente)
    await realtimeMiddleware(ctx('POST', 'http://x/api/logistica/tramos'), siguiente)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('un despacho en lote de 20 renglones manda UN aviso, no 20', async () => {
    for (let i = 0; i < 20; i++) {
      await realtimeMiddleware(ctx('POST', `http://x/api/solicitudes/items/${i}/despachar`), siguiente)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('el aviso va al tópico acordado y con payload VACÍO (el canal es público)', async () => {
    await realtimeMiddleware(ctx('POST', 'http://x/api/solicitudes/items/1/comprar'), siguiente)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://proyecto.supabase.co/realtime/v1/api/broadcast')
    const body = JSON.parse(String(init.body))
    expect(body.messages[0].topic).toBe(TOPICO_CAMBIOS)
    expect(body.messages[0].payload).toEqual({})
  })

  it('si el broadcast explota, la request del usuario no se cae', async () => {
    fetchMock.mockRejectedValueOnce(new Error('red caída'))
    await expect(
      realtimeMiddleware(ctx('POST', 'http://x/api/solicitudes/items/1/comprar'), siguiente),
    ).resolves.toBeUndefined()
  })
})
