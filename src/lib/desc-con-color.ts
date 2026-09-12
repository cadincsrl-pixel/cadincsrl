// Espejo EXACTO de public.desc_con_color() (migración 20260913t/u).
//
// El color del renglón vive en `solicitud_compra_item.color`, pero los tres
// documentos que le llegan a alguien de afuera —el remito que firma la obra, la
// cuenta del cliente y el certificado— imprimen la `descripcion`
// desnormalizada, no el item. Así que el color se compone DENTRO de la
// descripción al escribir. Sin esto el color moría en la pantalla del pedido:
// al 12/09 había 18 renglones de 3.666 con color cargado, y 0 de 398 en
// pintura, porque el campo no servía para nada.
//
// Hay dos implementaciones a propósito, no por duplicación: las RPC de
// resolución escriben MCC desde SQL y no pasan por acá. Si cambia una, cambiar
// la otra — igual que `lib/semanas.ts` y su espejo del frontend.
import { normTxt } from './norm-txt.js'

export function descConColor(desc: string | null | undefined, color: string | null | undefined): string {
  const d = desc ?? ''
  const c = (color ?? '').trim()
  if (c === '') return d
  // Si el color ya está en el nombre de la ficha, no repetirlo: hay fichas que
  // lo llevan en el nombre ("… SW 6105 Divine White x 20lts").
  if (normTxt(d).includes(normTxt(c))) return d
  return `${d} (${c})`
}
