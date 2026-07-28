// ¿El valor nuevo es realmente distinto del guardado? Los formularios mandan
// el registro COMPLETO aunque se haya tocado un solo campo, así que sin esta
// comparación los guards bloquearían por campos que llegaron iguales.
// Ojo: Postgres devuelve los numeric como string ("30.04") y varias columnas
// de texto son NOT NULL con default '', así que null y '' son el mismo
// "sin dato".
export function valorCambio(nuevo: unknown, guardado: unknown): boolean {
  if (nuevo === guardado) return false
  if (nuevo == null && guardado == null) return false
  const nNuevo = nuevo == null || nuevo === '' ? NaN : Number(nuevo)
  const nGuard = guardado == null || guardado === '' ? NaN : Number(guardado)
  if (!Number.isNaN(nNuevo) && !Number.isNaN(nGuard)) return nNuevo !== nGuard
  return String(nuevo ?? '') !== String(guardado ?? '')
}
