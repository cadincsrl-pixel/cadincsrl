import { createHash, randomUUID } from 'node:crypto'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import type {
  CreateContratistaDto,
  UpdateContratistaDto,
  AsigContratistaDto,
  CreatePresupuestoDto,
  UpdatePresupuestoDto,
  CertificacionDto,
  UpdateCertificacionDto,
  DocUploadUrlDto,
  DocRegistrarDto,
} from './contratistas.schema.js'

// Error tipado del módulo. El onError del sub-app (contratistas.routes.ts) lo
// traduce a `{ error: <mensaje legible>, code?: <CODIGO>, ...detail }`.
export class ContratError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    message: string,
    public code?: string,
    public detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ContratError'
  }
}

type Db = ReturnType<typeof createSupabaseClient>
type PgError = { code?: string; message: string }
const esUnique = (e: PgError) => e.code === '23505'

// ── Storage (bucket privado contratista-docs) ────────────────────────
// Lo comparten el DNI del contratista (contratista/{id}/…) y el adjunto del
// presupuesto (presupuesto/{id}/…). Flujo de 2 pasos calcado de vehiculo-docs:
// signed upload URL → el cliente sube → registrar el path. El hash y el
// tamaño se leen del archivo ya subido (no se confía en lo que declara el
// cliente). Storage siempre con el cliente admin (bucket privado).
const DOCS_BUCKET = 'contratista-docs'
const DOC_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
])
const DOC_MAX_BYTES = 10 * 1024 * 1024
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}

function validarArchivo(dto: DocUploadUrlDto): void {
  if (!DOC_ALLOWED_MIME.has(dto.mime_type)) {
    throw new ContratError(400, 'Tipo de archivo no permitido (foto o PDF)')
  }
  if (dto.size_bytes <= 0 || dto.size_bytes > DOC_MAX_BYTES) {
    throw new ContratError(400, 'Archivo demasiado grande (máx 10 MB)')
  }
}

// Path del adjunto tal como lo generó crearUploadUrl: {prefijo}/{id}/{uuid}.{ext}.
// Regex estricta en vez de startsWith: un path con `..` pasaría el prefijo y
// Storage normaliza la URL → se registraría/firmaría un objeto de otra carpeta.
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
function validarStoragePath(storagePath: string, prefijo: string, id: number): void {
  const m = new RegExp(`^${prefijo}/(\\d+)/${UUID_RE}\\.(jpg|png|webp|heic|heif|pdf|bin)$`).exec(storagePath)
  if (!m || Number(m[1]) !== id) throw new ContratError(400, 'Path inválido')
}

async function crearUploadUrl(path: string) {
  const { data, error } = await supabaseAdmin.storage.from(DOCS_BUCKET).createSignedUploadUrl(path)
  if (error) throw new ContratError(500, error.message)
  return { path, token: data.token, signed_url: data.signedUrl }
}

async function leerArchivoSubido(storagePath: string): Promise<{ hash: string; size: number }> {
  const dl = await supabaseAdmin.storage.from(DOCS_BUCKET).download(storagePath)
  if (dl.error || !dl.data) {
    throw new ContratError(400, 'El archivo no se subió correctamente')
  }
  const buf = Buffer.from(await dl.data.arrayBuffer())
  return { hash: createHash('sha256').update(buf).digest('hex'), size: dl.data.size }
}

async function crearSignedUrl(path: string, nombre: string | null) {
  const { data, error } = await supabaseAdmin.storage
    .from(DOCS_BUCKET)
    .createSignedUrl(path, 900, { download: nombre ?? undefined })
  if (error) throw new ContratError(500, error.message)
  return { url: data.signedUrl, nombre_archivo: nombre }
}

// Best-effort: un archivo huérfano en el bucket no justifica fallar la request.
async function borrarArchivo(path: string | null | undefined): Promise<void> {
  if (!path) return
  await supabaseAdmin.storage.from(DOCS_BUCKET).remove([path]).catch(() => undefined)
}

// Title Case con colapso de espacios: "  CESAR   LADRILLOS " → "Cesar Ladrillos".
// Se aplica a contratistas.nom en create/update para que el catálogo no vuelva
// a mezclar mayúsculas/minúsculas (los datos viejos se emparejaron con la
// migración 20260815_contratistas_nom_initcap).
function normalizarNom(nom: string): string {
  return nom
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s.'-])\p{L}/gu, (m) => m.toUpperCase())
}

// ── Selects explícitos ───────────────────────────────────────────────
// asig_contrat: NUNCA `*` — las columnas cotizacion* siguen existiendo hasta
// la fase 2 y no deben salir por la API.
const ASIG_COLS   = 'obra_cod, contrat_id, finalizado_en, created_at, updated_at, created_by, updated_by'
// El embed del contratista NO trae PII (dni/cuil/cuit/cbu/…): GET /asig solo
// exige tarja.lectura. El detalle completo sale por GET /contratistas (gateado).
const CONTRAT_PUBLIC_COLS = 'id, nom, razon_social, especialidad, tel, obs, created_at, updated_at, created_by, updated_by'
const ASIG_SELECT = `${ASIG_COLS}, contratistas(${CONTRAT_PUBLIC_COLS})`

// Campos de PII del contratista que se omiten para usuarios con ver_pii=false.
const CONTRAT_PII_KEYS = [
  'dni', 'cuil', 'cuit', 'cbu', 'alias_cbu', 'banco_cuenta', 'titular_cuenta',
  'dni_doc_path', 'dni_doc_nombre', 'dni_doc_mime', 'dni_doc_size', 'dni_doc_hash',
] as const
export function sinPii<T extends Record<string, unknown>>(row: T): Omit<T, (typeof CONTRAT_PII_KEYS)[number]> {
  const out: Record<string, unknown> = { ...row }
  for (const k of CONTRAT_PII_KEYS) delete out[k]
  return out as Omit<T, (typeof CONTRAT_PII_KEYS)[number]>
}
// contrat_presupuestos: sin doc_mime/doc_size/doc_hash (internos del adjunto).
const PRESUP_COLS = 'id, obra_cod, contrat_id, titulo, monto, fecha, obs, cerrado_en, doc_path, doc_nombre, created_at, updated_at, created_by, updated_by'
// certificaciones: sin `estado` (no se lee ni se escribe; se dropea en fase 2).
const CERT_COLS   = 'id, obra_cod, contrat_id, sem_key, monto, desc, presupuesto_id, created_at, updated_at, created_by, updated_by'

interface AsigRow {
  obra_cod: string
  contrat_id: number
  finalizado_en: string | null
}
interface PresupuestoRow {
  id: number
  obra_cod: string
  contrat_id: number
  titulo: string
  monto: number
  fecha: string
  obs: string | null
  cerrado_en: string | null
  doc_path: string | null
  doc_nombre: string | null
}
interface CertRow {
  id: number
  obra_cod: string
  contrat_id: number
  sem_key: string
  monto: number
  desc: string
  presupuesto_id: number | null
}

// ── Helpers de negocio ───────────────────────────────────────────────
async function contar(q: PromiseLike<{ count: number | null; error: PgError | null }>): Promise<number> {
  const { count, error } = await q
  if (error) throw new ContratError(500, error.message)
  return count ?? 0
}

async function getAsig(supabase: Db, obraCod: string, contratId: number): Promise<AsigRow> {
  const { data, error } = await supabase
    .from('asig_contrat')
    .select('obra_cod, contrat_id, finalizado_en')
    .eq('obra_cod', obraCod)
    .eq('contrat_id', contratId)
    .maybeSingle()
  if (error) throw new ContratError(500, error.message)
  if (!data) throw new ContratError(404, 'El contratista no está asignado a esta obra')
  return data as AsigRow
}

function exigirAsigActiva(asig: AsigRow): void {
  if (asig.finalizado_en) {
    throw new ContratError(
      409,
      'El contratista está finalizado en esta obra. Reactivalo para seguir cargando.',
      'ASIG_FINALIZADA',
    )
  }
}

async function getPresupuestoRow(supabase: Db, id: number): Promise<PresupuestoRow> {
  const { data, error } = await supabase
    .from('contrat_presupuestos')
    .select(PRESUP_COLS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new ContratError(500, error.message)
  if (!data) throw new ContratError(404, 'El presupuesto no existe')
  return data as PresupuestoRow
}

// Abiertos primero, luego fecha asc, id asc.
function ordenarPresupuestos(rows: PresupuestoRow[]): PresupuestoRow[] {
  return [...rows].sort((a, b) =>
    Number(a.cerrado_en != null) - Number(b.cerrado_en != null)
    || a.fecha.localeCompare(b.fecha)
    || a.id - b.id,
  )
}

async function getCertRow(supabase: Db, id: number): Promise<CertRow> {
  const { data, error } = await supabase
    .from('certificaciones')
    .select(CERT_COLS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new ContratError(500, error.message)
  if (!data) throw new ContratError(404, 'La certificación no existe')
  return data as CertRow
}

// Reglas de imputación de una certificación a un presupuesto:
//  · con presupuesto_id: existe, es del par obra×contratista y está abierto.
//  · sin presupuesto_id (histórico): solo si el par no tiene ningún
//    presupuesto abierto; si tiene ≥1 se exige elegir uno.
async function validarPresupuestoParaCert(
  supabase: Db,
  obraCod: string,
  contratId: number,
  presupuestoId: number | null,
): Promise<void> {
  if (presupuestoId != null) {
    const { data, error } = await supabase
      .from('contrat_presupuestos')
      .select('obra_cod, contrat_id, cerrado_en')
      .eq('id', presupuestoId)
      .maybeSingle()
    if (error) throw new ContratError(500, error.message)
    const p = data as Pick<PresupuestoRow, 'obra_cod' | 'contrat_id' | 'cerrado_en'> | null
    if (!p || p.obra_cod !== obraCod || p.contrat_id !== contratId) {
      throw new ContratError(
        400,
        'El presupuesto no existe o no es de este contratista en esta obra',
        'PRESUPUESTO_INVALIDO',
      )
    }
    if (p.cerrado_en) {
      throw new ContratError(
        409,
        'El presupuesto está cerrado. Reabrilo para imputarle certificaciones.',
        'PRESUPUESTO_CERRADO',
      )
    }
    return
  }

  const abiertos = await contar(
    supabase
      .from('contrat_presupuestos')
      .select('id', { count: 'exact', head: true })
      .eq('obra_cod', obraCod)
      .eq('contrat_id', contratId)
      .is('cerrado_en', null),
  )
  if (abiertos > 0) {
    throw new ContratError(
      400,
      'El contratista tiene presupuestos abiertos en esta obra: elegí a cuál imputar la certificación',
      'PRESUPUESTO_REQUERIDO',
    )
  }
}

// Cert de la tupla (obra, contratista, semana, presupuesto). presupuesto null
// se filtra con .is() (la UNIQUE es NULLS NOT DISTINCT: NULL cuenta como valor).
async function buscarCertEnSemana(
  supabase: Db,
  obraCod: string,
  contratId: number,
  semKey: string,
  presupuestoId: number | null,
  excluirId?: number,
): Promise<number | null> {
  let q = supabase
    .from('certificaciones')
    .select('id')
    .eq('obra_cod', obraCod)
    .eq('contrat_id', contratId)
    .eq('sem_key', semKey)
  q = presupuestoId == null ? q.is('presupuesto_id', null) : q.eq('presupuesto_id', presupuestoId)
  if (excluirId != null) q = q.neq('id', excluirId)
  const { data, error } = await q.limit(1).maybeSingle()
  if (error) throw new ContratError(500, error.message)
  return (data as { id: number } | null)?.id ?? null
}

// Título del presupuesto embebido en cada cert (presupuesto_titulo). Dos
// queries: certs y luego los títulos de los ids distintos.
async function titulosDe(supabase: Db, ids: Array<number | null>): Promise<Map<number, string>> {
  const distintos = Array.from(new Set(ids.filter((id): id is number => id != null)))
  const titulos = new Map<number, string>()
  if (distintos.length === 0) return titulos
  const { data, error } = await supabase
    .from('contrat_presupuestos')
    .select('id, titulo')
    .in('id', distintos)
  if (error) throw new ContratError(500, error.message)
  for (const p of (data ?? []) as Array<{ id: number; titulo: string }>) titulos.set(p.id, p.titulo)
  return titulos
}

function conTituloDe<T extends { presupuesto_id: number | null }>(row: T, titulos: Map<number, string>) {
  return {
    ...row,
    presupuesto_titulo: row.presupuesto_id != null ? (titulos.get(row.presupuesto_id) ?? null) : null,
  }
}

async function adjuntarTitulos<T extends { presupuesto_id: number | null }>(supabase: Db, rows: T[]) {
  const titulos = await titulosDe(supabase, rows.map(r => r.presupuesto_id))
  return rows.map(r => conTituloDe(r, titulos))
}

async function conTitulo(supabase: Db, row: CertRow) {
  return conTituloDe(row, await titulosDe(supabase, [row.presupuesto_id]))
}

export const contratistasService = {

  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .select('*')
      .order('id')

    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: CreateContratistaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .insert({ ...dto, nom: normalizarNom(dto.nom), created_by: userId, updated_by: userId })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateContratistaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const patch = dto.nom != null ? { ...dto, nom: normalizarNom(dto.nom) } : dto
    const { data, error } = await supabase
      .from('contratistas')
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    // Si tenía DNI adjunto, borrar el archivo del bucket (best-effort).
    const { data: prev } = await supabase
      .from('contratistas').select('dni_doc_path').eq('id', id).single()
    const { error } = await supabase
      .from('contratistas')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
    await borrarArchivo((prev as { dni_doc_path?: string | null } | null)?.dni_doc_path)
    return { success: true }
  },

  // ── DNI adjunto (foto/PDF, bucket contratista-docs) ───────────
  async dniUploadUrl(contratId: number, dto: DocUploadUrlDto) {
    validarArchivo(dto)
    return crearUploadUrl(`contratista/${contratId}/${randomUUID()}.${extFromMime(dto.mime_type)}`)
  },

  async dniRegistrar(contratId: number, dto: DocRegistrarDto, userId: string, token: string) {
    validarStoragePath(dto.storage_path, 'contratista', contratId)
    const { hash, size } = await leerArchivoSubido(dto.storage_path)

    const supabase = createSupabaseClient(token)
    const { data: prev } = await supabase
      .from('contratistas').select('dni_doc_path').eq('id', contratId).single()

    const { data, error } = await supabase
      .from('contratistas')
      .update({
        dni_doc_path:   dto.storage_path,
        dni_doc_nombre: dto.nombre_archivo,
        dni_doc_mime:   dto.mime_type,
        dni_doc_size:   size,
        dni_doc_hash:   hash,
        updated_by:     userId,
      })
      .eq('id', contratId)
      .select()
      .single()
    if (error) throw new ContratError(500, error.message)

    const prevPath = (prev as { dni_doc_path?: string | null } | null)?.dni_doc_path
    if (prevPath && prevPath !== dto.storage_path) await borrarArchivo(prevPath)
    return data
  },

  async dniSignedUrl(contratId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data: c, error } = await supabase
      .from('contratistas')
      .select('dni_doc_path, dni_doc_nombre')
      .eq('id', contratId)
      .single()
    if (error) throw new ContratError(500, error.message)
    if (!c?.dni_doc_path) {
      throw new ContratError(404, 'El contratista no tiene DNI adjunto')
    }
    return crearSignedUrl(c.dni_doc_path, c.dni_doc_nombre ?? null)
  },

  async dniDelete(contratId: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data: prev } = await supabase
      .from('contratistas').select('dni_doc_path').eq('id', contratId).single()

    const { data, error } = await supabase
      .from('contratistas')
      .update({
        dni_doc_path:   null,
        dni_doc_nombre: null,
        dni_doc_mime:   null,
        dni_doc_size:   null,
        dni_doc_hash:   null,
        updated_by:     userId,
      })
      .eq('id', contratId)
      .select()
      .single()
    if (error) throw new ContratError(500, error.message)

    await borrarArchivo((prev as { dni_doc_path?: string | null } | null)?.dni_doc_path)
    return data
  },

  // ── Asignaciones a obras ──────────────────────────────────────
  // Activos (finalizado_en null) primero.
  async getAsigByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asig_contrat')
      .select(ASIG_SELECT)
      .eq('obra_cod', obraCod)
      .order('finalizado_en', { ascending: true, nullsFirst: true })
      .order('contrat_id')

    if (error) throw new ContratError(500, error.message)
    return data
  },

  async asignar(dto: AsigContratistaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asig_contrat')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select(ASIG_SELECT)
      .single()

    if (error) {
      if (esUnique(error)) {
        throw new ContratError(409, 'El contratista ya está asignado a esta obra', 'ASIG_DUPLICADA')
      }
      throw new ContratError(500, error.message)
    }
    return data
  },

  // Finalizar = el contratista no certifica más en la obra, pero su historial
  // (certificaciones y presupuestos) queda intacto. Reversible.
  async finalizarAsig(obraCod: string, contratId: number, finalizado: boolean, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const ahora = new Date().toISOString()
    const { data, error } = await supabase
      .from('asig_contrat')
      .update({
        finalizado_en: finalizado ? ahora : null,
        updated_by:    userId,
        updated_at:    ahora,
      })
      .eq('obra_cod', obraCod)
      .eq('contrat_id', contratId)
      .select(ASIG_SELECT)
      .maybeSingle()

    if (error) throw new ContratError(500, error.message)
    if (!data) throw new ContratError(404, 'El contratista no está asignado a esta obra')
    return data
  },

  // Desasignar borra la fila solo si el par no tiene historial. Con
  // certificaciones o presupuestos, 409: el camino es "finalizar" (las certs
  // no cuelgan de la asignación y quedarían sumando invisibles; los
  // presupuestos se borrarían en cascada con sus adjuntos).
  async desasignar(obraCod: string, contratId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const [certs, presupuestos] = await Promise.all([
      contar(
        supabase.from('certificaciones').select('id', { count: 'exact', head: true })
          .eq('obra_cod', obraCod).eq('contrat_id', contratId),
      ),
      contar(
        supabase.from('contrat_presupuestos').select('id', { count: 'exact', head: true })
          .eq('obra_cod', obraCod).eq('contrat_id', contratId),
      ),
    ])
    if (certs > 0 || presupuestos > 0) {
      throw new ContratError(
        409,
        `El contratista tiene historial en esta obra (${certs} certificación/es, ${presupuestos} presupuesto/s). Finalizalo en vez de desasignarlo.`,
        'ASIG_CON_HISTORIAL',
        { certs, presupuestos },
      )
    }

    const { error } = await supabase
      .from('asig_contrat')
      .delete()
      .eq('obra_cod', obraCod)
      .eq('contrat_id', contratId)

    if (error) throw new ContratError(500, error.message)
    return { success: true }
  },

  // ── Presupuestos ──────────────────────────────────────────────
  async getPresupuestosByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contrat_presupuestos')
      .select(PRESUP_COLS)
      .eq('obra_cod', obraCod)

    if (error) throw new ContratError(500, error.message)
    return ordenarPresupuestos((data ?? []) as PresupuestoRow[])
  },

  // Lookup para que la ruta valide el scope por la obra del presupuesto.
  async getPresupuesto(id: number, token: string): Promise<PresupuestoRow> {
    return getPresupuestoRow(createSupabaseClient(token), id)
  },

  async createPresupuesto(dto: CreatePresupuestoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    exigirAsigActiva(await getAsig(supabase, dto.obra_cod, dto.contrat_id))

    const { data, error } = await supabase
      .from('contrat_presupuestos')
      .insert({
        obra_cod:   dto.obra_cod,
        contrat_id: dto.contrat_id,
        titulo:     dto.titulo,
        monto:      dto.monto,
        ...(dto.fecha ? { fecha: dto.fecha } : {}),
        obs:        dto.obs ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(PRESUP_COLS)
      .single()

    if (error) {
      if (esUnique(error)) {
        throw new ContratError(
          409,
          'Ya hay un presupuesto con ese título para este contratista en la obra',
          'TITULO_DUPLICADO',
        )
      }
      throw new ContratError(500, error.message)
    }
    return data as PresupuestoRow
  },

  async updatePresupuesto(id: number, dto: UpdatePresupuestoDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const patch: Record<string, unknown> = {}
    if (dto.titulo  !== undefined) patch.titulo = dto.titulo
    if (dto.monto   !== undefined) patch.monto  = dto.monto
    if (dto.fecha   !== undefined) patch.fecha  = dto.fecha
    if (dto.obs     !== undefined) patch.obs    = dto.obs
    if (dto.cerrado !== undefined) {
      // Cerrar uno ya cerrado no pisa la fecha original de cierre.
      const prev = await getPresupuestoRow(supabase, id)
      patch.cerrado_en = dto.cerrado ? (prev.cerrado_en ?? new Date().toISOString()) : null
    }
    if (Object.keys(patch).length === 0) return getPresupuestoRow(supabase, id)

    const { data, error } = await supabase
      .from('contrat_presupuestos')
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .select(PRESUP_COLS)
      .maybeSingle()

    if (error) {
      if (esUnique(error)) {
        throw new ContratError(
          409,
          'Ya hay un presupuesto con ese título para este contratista en la obra',
          'TITULO_DUPLICADO',
        )
      }
      throw new ContratError(500, error.message)
    }
    if (!data) throw new ContratError(404, 'El presupuesto no existe')
    return data as PresupuestoRow
  },

  async deletePresupuesto(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const prev = await getPresupuestoRow(supabase, id)
    const n = await contar(
      supabase.from('certificaciones').select('id', { count: 'exact', head: true }).eq('presupuesto_id', id),
    )
    if (n > 0) {
      throw new ContratError(
        409,
        `El presupuesto tiene ${n} certificación/es imputadas. Cerralo, o reimputá sus certificaciones a otro presupuesto antes de borrarlo.`,
        'PRESUPUESTO_CON_CERTS',
        { n },
      )
    }

    const { error } = await supabase
      .from('contrat_presupuestos')
      .delete()
      .eq('id', id)

    if (error) throw new ContratError(500, error.message)
    await borrarArchivo(prev.doc_path)
    return { success: true }
  },

  // ── Adjunto del presupuesto (foto/PDF) ────────────────────────
  async presupDocUploadUrl(id: number, dto: DocUploadUrlDto) {
    validarArchivo(dto)
    return crearUploadUrl(`presupuesto/${id}/${randomUUID()}.${extFromMime(dto.mime_type)}`)
  },

  async presupDocRegistrar(id: number, dto: DocRegistrarDto, userId: string, token: string) {
    validarStoragePath(dto.storage_path, 'presupuesto', id)
    const { hash, size } = await leerArchivoSubido(dto.storage_path)

    const supabase = createSupabaseClient(token)
    const prev = await getPresupuestoRow(supabase, id)

    const { data, error } = await supabase
      .from('contrat_presupuestos')
      .update({
        doc_path:   dto.storage_path,
        doc_nombre: dto.nombre_archivo,
        doc_mime:   dto.mime_type,
        doc_size:   size,
        doc_hash:   hash,
        updated_by: userId,
      })
      .eq('id', id)
      .select(PRESUP_COLS)
      .single()
    if (error) throw new ContratError(500, error.message)

    if (prev.doc_path && prev.doc_path !== dto.storage_path) await borrarArchivo(prev.doc_path)
    return data as PresupuestoRow
  },

  async presupDocSignedUrl(id: number, token: string) {
    const p = await getPresupuestoRow(createSupabaseClient(token), id)
    if (!p.doc_path) throw new ContratError(404, 'El presupuesto no tiene adjunto')
    return crearSignedUrl(p.doc_path, p.doc_nombre)
  },

  async presupDocDelete(id: number, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const prev = await getPresupuestoRow(supabase, id)

    const { data, error } = await supabase
      .from('contrat_presupuestos')
      .update({
        doc_path:   null,
        doc_nombre: null,
        doc_mime:   null,
        doc_size:   null,
        doc_hash:   null,
        updated_by: userId,
      })
      .eq('id', id)
      .select(PRESUP_COLS)
      .single()
    if (error) throw new ContratError(500, error.message)

    await borrarArchivo(prev.doc_path)
    return data as PresupuestoRow
  },

  // ── Certificaciones ───────────────────────────────────────────
  async getCertByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('certificaciones')
      .select(CERT_COLS)
      .eq('obra_cod', obraCod)
      .order('sem_key', { ascending: false })

    if (error) throw new ContratError(500, error.message)
    return adjuntarTitulos(supabase, (data ?? []) as CertRow[])
  },

  // Todas las certs visibles por el usuario. allowed = null → admin / scope
  // "todas" (path admin sin cambios); array → RPC (evita el cap de 1000).
  async getCertAll(allowed: string[] | null, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = allowed != null
      ? await supabase.rpc('certificaciones_de_obras', { p_obras: allowed })
      : await supabase.from('certificaciones').select('*').range(0, 99999)
    if (error) throw new ContratError(500, error.message)
    return adjuntarTitulos(supabase, (data ?? []) as CertRow[])
  },

  // Lookup para que la ruta valide el scope por la obra de la certificación.
  async getCert(id: number, token: string): Promise<CertRow> {
    return getCertRow(createSupabaseClient(token), id)
  },

  // Upsert por tupla (obra, contratista, semana, presupuesto): volver a cargar
  // reemplaza el monto. Manual (select → update | insert) porque PostgREST no
  // infiere bien el arbiter de una UNIQUE NULLS NOT DISTINCT.
  async upsertCert(dto: CertificacionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    exigirAsigActiva(await getAsig(supabase, dto.obra_cod, dto.contrat_id))
    const presupuestoId = dto.presupuesto_id ?? null
    await validarPresupuestoParaCert(supabase, dto.obra_cod, dto.contrat_id, presupuestoId)

    const existenteId = await buscarCertEnSemana(
      supabase, dto.obra_cod, dto.contrat_id, dto.sem_key, presupuestoId,
    )
    const { data, error } = existenteId != null
      ? await supabase
          .from('certificaciones')
          .update({ monto: dto.monto, desc: dto.desc, updated_by: userId })
          .eq('id', existenteId)
          .select(CERT_COLS)
          .single()
      : await supabase
          .from('certificaciones')
          .insert({
            obra_cod:       dto.obra_cod,
            contrat_id:     dto.contrat_id,
            sem_key:        dto.sem_key,
            monto:          dto.monto,
            desc:           dto.desc,
            presupuesto_id: presupuestoId,
            created_by:     userId,
            updated_by:     userId,
          })
          .select(CERT_COLS)
          .single()

    if (error) {
      // UNIQUE (obra, contratista, semana, presupuesto). Hasta que se aplique la
      // fase 2a (drop de la UNIQUE vieja) también pega acá una 2da cert la misma
      // semana para otro presupuesto.
      if (esUnique(error)) {
        throw new ContratError(
          409,
          'Ya hay una certificación de este contratista para esa semana y presupuesto',
          'CERT_DUPLICADA',
        )
      }
      throw new ContratError(500, error.message)
    }
    return conTitulo(supabase, data as CertRow)
  },

  // Corregir monto/desc o reimputar a otro presupuesto (mismas reglas que el
  // PUT cuando viene presupuesto_id).
  async updateCert(id: number, dto: UpdateCertificacionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const cert = await getCertRow(supabase, id)

    const patch: Record<string, unknown> = {}
    if (dto.monto !== undefined) patch.monto = dto.monto
    if (dto.desc  !== undefined) patch.desc  = dto.desc

    if (dto.presupuesto_id !== undefined && dto.presupuesto_id !== cert.presupuesto_id) {
      const destino = dto.presupuesto_id
      await validarPresupuestoParaCert(supabase, cert.obra_cod, cert.contrat_id, destino)
      const ocupada = await buscarCertEnSemana(
        supabase, cert.obra_cod, cert.contrat_id, cert.sem_key, destino, id,
      )
      if (ocupada != null) {
        throw new ContratError(
          409,
          'Ya hay una certificación de este contratista esa semana para ese presupuesto',
          'CERT_DUPLICADA',
        )
      }
      patch.presupuesto_id = destino
    }

    if (Object.keys(patch).length === 0) return conTitulo(supabase, cert)

    const { data, error } = await supabase
      .from('certificaciones')
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .select(CERT_COLS)
      .single()

    if (error) {
      if (esUnique(error)) {
        throw new ContratError(
          409,
          'Ya hay una certificación de este contratista esa semana para ese presupuesto',
          'CERT_DUPLICADA',
        )
      }
      throw new ContratError(500, error.message)
    }
    return conTitulo(supabase, data as CertRow)
  },

  async deleteCert(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('certificaciones')
      .delete()
      .eq('id', id)

    if (error) throw new ContratError(500, error.message)
    return { success: true }
  },
}
