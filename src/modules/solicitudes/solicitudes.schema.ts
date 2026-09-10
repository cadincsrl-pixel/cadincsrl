import { z } from 'zod'

/**
 * Las 12 unidades que acepta la base (CHECK solicitud_compra_item_unidad_check).
 *
 * Hasta 2026-09-08 acá había un `z.string()` libre: cualquier cosa que no fuera
 * de esta lista pasaba la validación y explotaba contra el CHECK como un 500
 * crudo de Postgres. Con el enum es un 400 legible. Importa más ahora que el
 * asistente puede cargar pedidos dictados, porque "20 bolsas" tienta a mandar
 * 'bolsas' en plural — pero el agujero existía igual desde la pantalla.
 */
export const UNIDADES = [
  'unid', 'kg', 'tn', 'lt', 'm', 'm2', 'm3', 'gl', 'rollo', 'bolsa', 'balde', 'lata',
] as const
const UnidadField = z.enum(UNIDADES).default('unid')

const ItemSchema = z.object({
  descripcion: z.string().min(1),
  // positive(): dejar la cantidad vacía en el form guardaba 0 en silencio
  // (73 items en 0 hasta 2026-07-22). Sin cantidad no hay pedido.
  cantidad:    z.number().positive(),
  unidad:      UnidadField,
  obs:         z.string().nullable().optional().default(null),
  material_id: z.number().int().positive().nullable().optional().default(null),
  // Color pedido. Texto libre a propósito: la carta de colores es del proveedor y
  // cambia. El front solo muestra el campo si el material tiene `usa_color`
  // (ver migración 20260902s) — el backend no lo valida contra eso porque un
  // material puede dejar de usar color y los pedidos viejos seguirían siendo válidos.
  color:       z.string().nullable().optional().default(null),
  // material | herramienta. La derivacion al pañol es un filtro sobre esto.
  // Default 'material': todo lo existente y todo lo que nadie marque sigue igual.
  clase:       z.enum(['material', 'herramienta']).optional().default('material'),
  // Solo con clase='herramienta': la obra DEVUELVE en vez de pedir. Es el
  // disparador de la devolucion, que hasta ahora no existia (11 devoluciones
  // contra 22 asignaciones en el historico).
  devuelve:    z.boolean().optional().default(false),
}).refine(d => !d.devuelve || d.clase === 'herramienta', {
  // El CHECK de la tabla rechaza devuelve=true con clase='material'. Sin este
  // refine el body llegaba a Postgres y volvia un 500 con el texto crudo del
  // constraint; asi es un 400 con mensaje claro.
  message: 'Solo una herramienta se puede devolver',
  path: ['devuelve'],
})

export const ResolverStockClienteSchema = z.object({
  stock_item_id: z.number().int().positive(),
})

export const CreateSolicitudSchema = z.object({
  obra_cod:  z.string().min(1),
  prioridad: z.enum(['normal', 'urgente']).default('normal'),
  obs:       z.string().nullable().optional().default(null),
  // Fecha+hora tentativa de entrega ("YYYY-MM-DDTHH:mm" del <datetime-local>).
  // Se guarda en timestamp sin tz; nullable.
  entrega_tentativa: z.string().min(1).nullable().optional().default(null),
  items:     z.array(ItemSchema).min(1),
})

const UpdateItemSchema = z.object({
  id:          z.number().int().positive().optional(), // si tiene id, es update; si no, es nuevo
  descripcion: z.string().min(1),
  cantidad:    z.number().positive(),
  unidad:      UnidadField,
  obs:         z.string().nullable().optional().default(null),
  material_id: z.number().int().positive().nullable().optional().default(null),
  // Color pedido. Texto libre a propósito: la carta de colores es del proveedor y
  // cambia. El front solo muestra el campo si el material tiene `usa_color`
  // (ver migración 20260902s) — el backend no lo valida contra eso porque un
  // material puede dejar de usar color y los pedidos viejos seguirían siendo válidos.
  color:       z.string().nullable().optional().default(null),
  // material | herramienta. La derivacion al pañol es un filtro sobre esto.
  // Default 'material': todo lo existente y todo lo que nadie marque sigue igual.
  clase:       z.enum(['material', 'herramienta']).optional().default('material'),
  // Solo con clase='herramienta': la obra DEVUELVE en vez de pedir. Es el
  // disparador de la devolucion, que hasta ahora no existia (11 devoluciones
  // contra 22 asignaciones en el historico).
  devuelve:    z.boolean().optional().default(false),
}).refine(d => !d.devuelve || d.clase === 'herramienta', {
  // El CHECK de la tabla rechaza devuelve=true con clase='material'. Sin este
  // refine el body llegaba a Postgres y volvia un 500 con el texto crudo del
  // constraint; asi es un 400 con mensaje claro.
  message: 'Solo una herramienta se puede devolver',
  path: ['devuelve'],
})

export const UpdateSolicitudSchema = z.object({
  estado:       z.enum(['pendiente', 'aprobada', 'rechazada']).optional(),
  prioridad:    z.enum(['normal', 'urgente']).optional(),
  obs:          z.string().nullable().optional(),
  entrega_tentativa: z.string().nullable().optional(),
  obra_cod:     z.string().min(1).optional(),
  items:        z.array(UpdateItemSchema).optional(), // si se envía, reemplaza ítems pendientes
  remove_items: z.array(z.number().int().positive()).optional(), // IDs de ítems a eliminar
})

// Resolver ítem: comprar a proveedor.
// Si `queda_en_proveedor=true`, el material no llega a CADINC ni a la
// obra todavía: queda en el galpón del proveedor hasta que se haga un
// remito de retiro. El item pasa a estado 'en_proveedor' (vs 'comprado'),
// no se inserta en `materiales_a_cuenta_cliente` hasta que se retire.
//
// `pagado_por` indica quién pagó al proveedor:
// - 'cadinc' (default): CADINC adelantó. Se suma a la cuenta del cliente.
// - 'cliente': el cliente pagó directo. Solo registro de rendición, no genera deuda.
export const ComprarItemSchema = z.object({
  proveedor_id:        z.number().int().positive(),
  // Compra externa: el precio se conoce al momento (factura), así que es
  // obligatorio > 0 para no generar materiales a cuenta del cliente en $0...
  // salvo cuando el proveedor lo pasa después (cuenta corriente): ahí entra en
  // 0 con `esperando_precio` y el renglón queda marcado hasta que se cargue
  // (20260912c). El refine de abajo exige una de las dos cosas. El despacho de
  // depósito SÍ admite 0 siempre (lo tasan después; ver DespacharItemSchema).
  precio_unit:         z.number().min(0),
  factura_id:          z.number().int().positive().nullable().optional(),
  queda_en_proveedor:  z.boolean().optional().default(false),
  pagado_por:          z.enum(['cadinc', 'cliente']).optional().default('cadinc'),
  // Cantidad realmente comprada si difiere de la solicitada. Si no viene,
  // se compró lo solicitado (cantidad_comprada queda NULL).
  cantidad_comprada:   z.number().positive().optional(),
  // Poner este precio como precio de referencia del catalogo (20260911). No es
  // columna: el service valida ANTES de resolver (ficha, unidad compatible,
  // factura no anterior al precio vigente) y llama fijar_precio_ref DESPUES,
  // con fuente 'compra' y el renglon. El route exige permiso de catalogo.
  actualizar_catalogo: z.boolean().optional().default(false),
  // La compra entra sin precio porque el proveedor todavía no lo pasó
  // (20260912c). La marca se apaga sola cuando se carga el precio (trigger
  // trg_item_esperando_precio), venga por Cargar precios o por el PATCH.
  esperando_precio:    z.boolean().optional().default(false),
}).refine(d => d.precio_unit > 0 || d.esperando_precio === true, {
  message: 'Cargá un precio mayor a 0 o marcá "esperando precio del proveedor"',
  path: ['precio_unit'],
})

// Resolver ítem: despachar de depósito
export const DespacharItemSchema = z.object({
  // Admite 0 a propósito: el encargado de depósito despacha sin saber el precio
  // de venta; queda "a tasar" y Alina/Nicolás le ponen precio después.
  precio_unit:        z.number().min(0),
  // Flag para forzar el despacho cuando no hay stock suficiente.
  // Requiere permiso extra `certificaciones.forzar_despacho` — lo valida
  // el handler del route. El service NO lee este campo del dto: el route
  // lo extrae, lo valida y lo pasa como argumento explícito a
  // `solicitudesService.despacharItem(..., forzarSinStock)`.
  forzar_sin_stock:   z.boolean().optional(),
  // El renglon sale en 0 a proposito y queda marcado para tasar (20260913).
  // Lo pone el route cuando quien despacha no tiene `precio_al_resolver`; no
  // se espera que lo mande el cliente. Sin esto el $0 del deposito se mezcla
  // con los $0 viejos y no hay forma de distinguir "todavia no lo tasaron" de
  // "esto quedo sin precio hace meses".
  esperando_precio:   z.boolean().optional().default(false),
})

// Enviar ítem
export const EnviarItemSchema = z.object({
  fecha_envio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

// Editar ítem resuelto (corregir precio/proveedor)
export const EditarItemSchema = z.object({
  /** Llevar este precio al catálogo, igual que el tilde de la compra. Hasta
   *  el 10/09 "actualizar catálogo" solo existía en el instante de comprar:
   *  la compra en cuenta corriente, que es la que trae el precio real días
   *  después, nunca podía devolverle el número a la ficha. */
  actualizar_catalogo: z.boolean().optional(),
  proveedor_id: z.number().int().positive().optional(),
  precio_unit:  z.number().min(0).optional(),
  factura_id:   z.number().int().positive().nullable().optional(),
  // Quién le pagó al proveedor. Editable después de resuelto (2026-09-08):
  // el caso real son renglones que quedaron como "CADINC adelantó" cuando en
  // realidad el cliente los pagó directo — cambiaba la deuda entera.
  pagado_por:   z.enum(['cadinc', 'cliente']).optional(),
  // Prender o apagar la marca a mano (20260912c). Cargar un precio > 0 la
  // apaga solo (trigger), no hace falta mandarla.
  esperando_precio: z.boolean().optional(),
  // "Pasar el renglón a la unidad de la ficha" (fase 3, 2026-09-09): la
  // cantidad viene ya expresada en la unidad nueva ("15 m de piola" → "0,3
  // rollo"). Van siempre juntos; el service recalcula la cuenta del cliente,
  // los envíos y el stock descontado en proporción.
  unidad:   z.enum(['unid', 'kg', 'tn', 'lt', 'm', 'm2', 'm3', 'gl', 'rollo', 'bolsa', 'balde', 'lata']).optional(),
  cantidad: z.number().positive().optional(),
}).refine(d => (d.unidad === undefined) === (d.cantidad === undefined), {
  message: 'Para cambiar la unidad hay que mandar unidad y cantidad juntas',
  path: ['cantidad'],
})

/**
 * Precios propuestos (20260912o): quien compra deja el precio esperando el OK
 * de quien tiene `cargar_precios`. La propuesta no mueve la cuenta del
 * cliente, así que acá solo se valida que sea un precio de verdad.
 */
export const ProponerPrecioSchema = z.object({
  precio_unit: z.number().positive(),
  obs:         z.string().trim().max(300).optional(),
})

/** Rechazar exige motivo: el que lo cargó tiene que saber por qué. */
export const RechazarPrecioSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
})

export type CreateSolicitudDto = z.infer<typeof CreateSolicitudSchema>
export type UpdateSolicitudDto = z.infer<typeof UpdateSolicitudSchema>
export type ComprarItemDto     = z.infer<typeof ComprarItemSchema>
export type DespacharItemDto   = z.infer<typeof DespacharItemSchema>
export type EnviarItemDto      = z.infer<typeof EnviarItemSchema>
export type EditarItemDto      = z.infer<typeof EditarItemSchema>
export type ProponerPrecioDto  = z.infer<typeof ProponerPrecioSchema>
export type RechazarPrecioDto  = z.infer<typeof RechazarPrecioSchema>
