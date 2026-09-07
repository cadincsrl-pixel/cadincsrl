/**
 * PostgREST corta TODA respuesta en 1000 filas y `.range(0, 99999)` no lo
 * evita: el cap lo aplica el servidor (CLAUDE.md §5.7). Para traer una tabla
 * entera hay que pedirla de a páginas con un orden estable (siempre terminar
 * con `.order('id')` o equivalente, si no una fila puede repetirse o faltar
 * entre páginas).
 *
 *   const filas = await todasLasFilas((desde, hasta) =>
 *     supabase.from('cierres').select('*').order('id').range(desde, hasta))
 */
export const PAGINA = 1000

interface Respuesta<T> {
  data: T[] | null
  error: { message: string } | null
}

export async function todasLasFilas<T>(
  pagina: (desde: number, hasta: number) => PromiseLike<Respuesta<T>>,
): Promise<T[]> {
  const todas: T[] = []
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await pagina(desde, desde + PAGINA - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    todas.push(...data)
    if (data.length < PAGINA) break
  }
  return todas
}
