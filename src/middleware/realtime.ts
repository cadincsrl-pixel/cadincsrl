import type { Context, Next } from 'hono'

/**
 * Aviso en vivo de que un pedido cambió, para las pantallas ya abiertas.
 *
 * EL PROBLEMA QUE RESUELVE. Dos personas mirando Certificaciones › Solicitudes:
 * Nicolás compra un renglón, el renglón pasa a enviado, y la pantalla de Alina
 * sigue mostrando el estado de hace diez minutos. React Query invalida al que
 * hizo la acción (`invalidarTodoLoQueTocaUnItem` en el front), pero eso no sale
 * de esa pestaña.
 *
 * POR QUÉ NO SE POLLEA. Ya se probó y ya rompió: pollear la lista completa de
 * `/api/solicitudes` (~400 KB con items y proveedores) cada 60 s agotó los 5 GB
 * de bandwidth del plan Hobby de Render en agosto de 2026 (está documentado en
 * `useNotificaciones.ts`). Con cuatro pantallas abiertas ocho horas son ~770 MB
 * por día, gastados casi enteros en respuestas idénticas.
 *
 * POR QUÉ NO ES EL REALTIME "NORMAL" DE SUPABASE. El otro camino sería
 * `postgres_changes`, que escucha la tabla. No sirve acá: desde la migración
 * `20260914d` el rol `authenticated` NO tiene SELECT sobre `solicitud_compra`
 * ni sobre `solicitud_compra_item` (la lectura directa del front se cerró a
 * propósito), y Realtime aplica los permisos del que escucha. El navegador se
 * suscribiría y no recibiría nada.
 *
 * LO QUE SÍ. Un broadcast: este middleware avisa "algo cambió" por un canal de
 * Supabase y el navegador recién entonces pide los datos por la API, con su
 * token y su alcance por obra. Dos propiedades que importan:
 *
 *   · El aviso NO LLEVA DATOS. Payload vacío: ni obra, ni id, ni usuario. El
 *     canal es público (cualquiera con la anon key puede escuchar), así que lo
 *     único que se filtra es "hubo actividad", y quién ve qué lo sigue
 *     decidiendo la API. Si algún día el payload tiene que llevar algo, hay que
 *     pasar el canal a privado primero.
 *   · El tráfico pesado deja de ser proporcional al reloj y pasa a ser
 *     proporcional a los cambios reales. El aviso son bytes y va por Supabase,
 *     no por Render.
 *
 * EL THROTTLE NO ES UN DETALLE. "Despachar 20 de depósito" son 20 requests;
 * sin esto serían 20 avisos y 20 refrescos de 400 KB en cada pantalla abierta,
 * o sea peor que el polling que estamos evitando. Un aviso por segundo alcanza:
 * el que escucha refresca una vez y ve las 20 filas ya cambiadas.
 *
 * Es best-effort a propósito: si el broadcast falla, la request del usuario ya
 * respondió bien y lo único que se pierde es la comodidad de no apretar F5.
 */

const METODOS_MUTATIVOS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Qué rutas mueven el estado que la pantalla de Solicitudes muestra. Los
 * remitos de envío entran porque son los que pasan un renglón a `enviado`.
 */
const RUTAS_QUE_AVISAN = [
  /^\/api\/solicitudes/,
  /^\/api\/remitos-envio/,
  // Pagos NO va acá: el tópico es único (`cadinc-solicitudes`) y el front lo
  // traduce en invalidar ['solicitudes'] en cada pestaña de Certificaciones
  // abierta (~400 KB por aviso). Si en fase 2 se quiere aviso en vivo para la
  // bandeja de facturas, va un tópico propio `cadinc-pagos` con su suscriptor.
]

export const TOPICO_CAMBIOS = 'cadinc-solicitudes'
const MS_ENTRE_AVISOS = 1000

let ultimoAviso = 0

export async function realtimeMiddleware(c: Context, next: Next) {
  await next()

  if (!METODOS_MUTATIVOS.has(c.req.method)) return
  if (c.res.status < 200 || c.res.status >= 300) return

  let ruta: string
  try {
    ruta = new URL(c.req.url).pathname
  } catch {
    return
  }
  if (!RUTAS_QUE_AVISAN.some((re) => re.test(ruta))) return

  const ahora = Date.now()
  if (ahora - ultimoAviso < MS_ENTRE_AVISOS) return
  ultimoAviso = ahora

  // Sin await: la respuesta del usuario no espera al aviso.
  void avisarCambio()
}

async function avisarCambio(): Promise<void> {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return

  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        messages: [{ topic: TOPICO_CAMBIOS, event: 'cambio', payload: {} }],
      }),
    })
  } catch {
    // Best-effort: ver el encabezado.
  }
}

/** Solo para los tests: volver a dejar el throttle en cero. */
export function _resetThrottle(): void {
  ultimoAviso = 0
}
