// Los candados de la única herramienta del asistente que ESCRIBE.
//
// El modelo se va a equivocar; la pregunta es cuáles de sus errores llegan a la
// base. Estos tests fijan los cuatro que no tienen que llegar:
//   · cargar antes de que la persona confirme
//   · una ficha que no se corresponde con lo que se dictó (el error invisible)
//   · una unidad distinta a la de la ficha (el que deja el precio ×20)
//   · una herramienta que no está en el catálogo
//   · un renglón SIN ficha cuando el catálogo sí la tiene (el pedido #697)
// Y que cuando todo está bien, el pedido sale por la ruta HTTP de siempre y no
// por adentro del service, que es lo que le da permisos y auditoría.
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Fila = Record<string, unknown>

const { estado } = vi.hoisted(() => ({
  estado: {
    obra: null as Fila | null,
    fichas: [] as Fila[],
    recientes: [] as Fila[],
    busquedas: [] as { texto: string }[],
    candidatosPorTexto: {} as Record<string, { material_id: number; nombre: string }[]>,
    posts: [] as { url: string; body: Record<string, unknown>; auth: string | null }[],
    respuestaPost: { ok: true, status: 200, json: { id: 999 } as unknown },
  },
}))

vi.mock('../../../src/lib/supabase.js', () => ({
  supabase: {
    from(tabla: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b, eq: () => b, in: () => b, gte: () => b,
        maybeSingle: () => Promise.resolve({ data: tabla === 'obras' ? estado.obra : null, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({
          data: tabla === 'stock_materiales' ? estado.fichas
              : tabla === 'solicitud_compra' ? estado.recientes
              : [],
          error: null,
        }).then(res),
      }
      return b
    },
  },
  createSupabaseClient: () => ({}),
}))

vi.mock('../../../src/modules/stock/stock.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>
  return {
    ...real,
    stockService: {
      buscarParaPedido: (consultas: { texto: string }[]) => {
        estado.busquedas.push(...consultas)
        return Promise.resolve(consultas.map(c => ({
          texto: c.texto,
          resolucion: 'varios',
          candidatos: estado.candidatosPorTexto[c.texto] ?? [],
        })))
      },
    },
  }
})

vi.mock('../../../src/app.js', () => ({
  app: {
    request: (url: string, init: { headers: Record<string, string>; body: string }) => {
      estado.posts.push({
        url,
        body: JSON.parse(init.body),
        auth: init.headers['Authorization'] ?? null,
      })
      const r = estado.respuestaPost
      return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.json) })
    },
  },
}))

const { PEDIDO_TOOLS } = await import('../../../src/modules/asistente/asistente.pedidos.js')
const crear = PEDIDO_TOOLS.find(t => t.name === 'crear_pedido')!

const PERFIL = { nombre: 'Nicolas Valdez', rol: 'operador', permisos: { certificaciones: { creacion: true, tabs: ['solicitudes'] } } }

/** Contexto con la conversación ya avanzada y la persona confirmando. */
const ctx = (mensajes = ['para la garita 20 bolsas de cemento portland', 'dale']) =>
  ({ userId: 'u1', token: 'tok', perfil: PERFIL, mensajesUsuario: mensajes }) as never

const ITEM_OK = {
  texto_dictado: 'cemento portland', descripcion: 'Cemento Portland x 25kg',
  cantidad: 20, unidad: 'bolsa' as const, material_id: 1,
}
const PEDIDO_OK = { obra_cod: 'CC-025', confirmacion_del_usuario: 'dale', items: [ITEM_OK] }

beforeEach(() => {
  estado.obra = { cod: 'CC-025', nom: 'GARITA', archivada: false, es_interna: false, materiales_a_cargo_de: 'cadinc' }
  estado.fichas = [{ id: 1, nombre: 'Cemento Portland x 25kg', unidad: 'bolsa', clase: 'material', usa_color: false, activo: true }]
  estado.recientes = []
  estado.busquedas = []
  estado.candidatosPorTexto = { 'cemento portland': [{ material_id: 1, nombre: 'Cemento Portland x 25kg' }] }
  estado.posts = []
  estado.respuestaPost = { ok: true, status: 200, json: { id: 999 } }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (dto: Record<string, unknown>, c = ctx()) => crear.run(dto, c) as Promise<any>

describe('crear_pedido — los candados', () => {
  it('no carga nada si la persona todavía no confirmó', async () => {
    const r = await run(PEDIDO_OK, ctx(['para la garita 20 bolsas de cemento portland']))
    expect(r.error).toBe('FALTA_CONFIRMACION')
    expect(estado.posts).toHaveLength(0)
  })

  it('no carga si la confirmación que dice el modelo no está en el último mensaje', async () => {
    const r = await run(PEDIDO_OK, ctx(['20 bolsas de cemento', 'esperá, dejame ver']))
    expect(r.error).toBe('FALTA_CONFIRMACION')
    expect(estado.posts).toHaveLength(0)
  })

  it('rechaza la ficha que no se corresponde con lo dictado (el id alucinado)', async () => {
    estado.fichas = [{ id: 7, nombre: 'Membrana asfáltica', unidad: 'bolsa', clase: 'material', usa_color: false, activo: true }]
    const r = await run({ ...PEDIDO_OK, items: [{ ...ITEM_OK, material_id: 7 }] })
    expect(r.error).toBe('MATERIAL_NO_COINCIDE_CON_LO_DICTADO')
    expect(estado.posts).toHaveLength(0)
  })

  it('rechaza la unidad que no es la de la ficha, y NO la corrige sola', async () => {
    const r = await run({ ...PEDIDO_OK, items: [{ ...ITEM_OK, unidad: 'kg' }] })
    expect(r.error).toBe('UNIDAD_DISTINTA_A_LA_FICHA')
    expect(r.unidad_de_la_ficha).toBe('bolsa')
    expect(r.detalle).toContain('NO reintentes')
    expect(estado.posts).toHaveLength(0)
  })

  it('rechaza una herramienta que no está en el catálogo', async () => {
    const r = await run({
      ...PEDIDO_OK,
      items: [{ texto_dictado: 'una amoladora', descripcion: 'Amoladora', cantidad: 1, unidad: 'unid', clase: 'herramienta', material_id: null }],
    })
    expect(r.error).toBe('HERRAMIENTA_SIN_FICHA')
    expect(estado.posts).toHaveLength(0)
  })


  // El error del pedido #697 (08/09/2026): el modelo no llamó a
  // buscar_materiales y mandó los seis renglones con material_id null. Como
  // escribió bien las descripciones, el pedido parecía sano; en realidad no
  // cruzaba ni precio ni stock y no se podía despachar de depósito.
  it('rechaza el renglón sin ficha cuando el catálogo SÍ tiene candidatos', async () => {
    const r = await run({ ...PEDIDO_OK, items: [{ ...ITEM_OK, material_id: null }] })
    expect(r.error).toBe('FALTA_ELEGIR_LA_FICHA')
    expect(r.candidatos).toHaveLength(1)
    expect(estado.posts).toHaveLength(0)
  })

  it('corta en el primer renglón sin ficha aunque los demás estén bien', async () => {
    estado.fichas.push({ id: 2, nombre: 'Arena x 25kg', unidad: 'bolsa', clase: 'material', usa_color: false, activo: true })
    estado.candidatosPorTexto['arena'] = [{ material_id: 2, nombre: 'Arena x 25kg' }]
    const r = await run({ ...PEDIDO_OK, items: [
      { ...ITEM_OK, material_id: 2, texto_dictado: 'arena', descripcion: 'Arena x 25kg' },
      { ...ITEM_OK, material_id: null },
    ] })
    expect(r.error).toBe('FALTA_ELEGIR_LA_FICHA')
    expect(estado.posts).toHaveLength(0)
  })

  it('rechaza un material_id que no existe en el catálogo', async () => {
    estado.fichas = []
    const r = await run({ ...PEDIDO_OK, items: [{ ...ITEM_OK, material_id: 4242 }] })
    expect(r.error).toBe('MATERIAL_INEXISTENTE')
    expect(estado.posts).toHaveLength(0)
  })

  it('no carga a una obra archivada', async () => {
    estado.obra = { ...estado.obra, archivada: true }
    const r = await run(PEDIDO_OK)
    expect(r.error).toBe('OBRA_ARCHIVADA')
    expect(estado.posts).toHaveLength(0)
  })

  it('avisa del posible duplicado en vez de cargar dos veces', async () => {
    estado.recientes = [{ id: 900, created_at: new Date().toISOString(), solicitud_compra_item: [{ id: 1 }] }]
    const r = await run(PEDIDO_OK)
    expect(r.error).toBe('POSIBLE_DUPLICADO')
    expect(r.solicitud_id).toBe(900)
    expect(estado.posts).toHaveLength(0)
  })

  it('sin permiso de creación no llega ni a mirar la obra', async () => {
    const sinPermiso = { userId: 'u1', token: 'tok', mensajesUsuario: ['x', 'dale'],
      perfil: { nombre: 'X', rol: 'operador', permisos: { certificaciones: { creacion: false } } } } as never
    const r = await run(PEDIDO_OK, sinPermiso)
    expect(r.error).toBe('SIN_PERMISO')
    expect(estado.posts).toHaveLength(0)
  })
})

describe('crear_pedido — el camino feliz', () => {
  it('sale por la ruta HTTP con el token del usuario, no por adentro del service', async () => {
    const r = await run(PEDIDO_OK)
    expect(r.ok).toBe(true)
    expect(r.solicitud_id).toBe(999)
    expect(estado.posts).toHaveLength(1)
    expect(estado.posts[0].url).toBe('/api/solicitudes')
    expect(estado.posts[0].auth).toBe('Bearer tok')
  })

  it('la descripción y la unidad las manda la FICHA, no lo que escribió el modelo', async () => {
    await run({ ...PEDIDO_OK, items: [{ ...ITEM_OK, descripcion: 'cementooo portlan' }] })
    const item = (estado.posts[0].body.items as Fila[])[0]
    expect(item.descripcion).toBe('Cemento Portland x 25kg')
    expect(item.unidad).toBe('bolsa')
  })

  it('borra el color cuando la ficha no usa color', async () => {
    await run({ ...PEDIDO_OK, items: [{ ...ITEM_OK, color: 'rojo' }] })
    expect((estado.posts[0].body.items as Fila[])[0].color).toBeNull()
  })

  it('deja el origen a la vista del comprador en el obs de cabecera', async () => {
    await run(PEDIDO_OK)
    expect(String(estado.posts[0].body.obs)).toMatch(/^\[asistente\]/)
  })


  it('el texto libre sigue pasando cuando la búsqueda no encuentra nada', async () => {
    estado.candidatosPorTexto = {}
    const r = await run({ ...PEDIDO_OK, items: [{
      texto_dictado: 'perfil raro que no existe', descripcion: 'Perfil raro',
      cantidad: 1, unidad: 'unid', material_id: null,
    }] })
    expect(r.ok).toBe(true)
    expect(r.sin_catalogar).toBe(1)
    expect((estado.posts[0].body.items as Fila[])[0].material_id).toBeNull()
  })

  it('el texto libre pasa igual si la persona ya dijo que ninguno de los candidatos sirve', async () => {
    const r = await run({ ...PEDIDO_OK, items: [{
      ...ITEM_OK, material_id: null, sin_ficha_confirmado: true,
    }] })
    expect(r.ok).toBe(true)
    expect(r.sin_catalogar).toBe(1)
  })

  it('sin_ficha_confirmado es una señal para el servidor, no viaja al pedido', async () => {
    await run({ ...PEDIDO_OK, items: [{ ...ITEM_OK, material_id: null, sin_ficha_confirmado: true }] })
    expect((estado.posts[0].body.items as Fila[])[0]).not.toHaveProperty('sin_ficha_confirmado')
  })

  it('si la ruta rechaza, lo cuenta y no inventa que lo cargó', async () => {
    estado.respuestaPost = { ok: false, status: 403, json: { error: 'SIN_PERMISO' } }
    const r = await run(PEDIDO_OK)
    expect(r.error).toBe('NO_SE_PUDO_CARGAR')
    expect(r.ok).toBeUndefined()
  })
})
