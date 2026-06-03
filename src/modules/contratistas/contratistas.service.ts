import { createHash, randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { supabase as supabaseAdmin, createSupabaseClient } from '../../lib/supabase.js'
import type {
  CreateContratistaDto,
  UpdateContratistaDto,
  AsigContratistaDto,
  CertificacionDto,
  DniUploadUrlDto,
  DniRegistrarDto,
} from './contratistas.schema.js'

// ── Storage del DNI adjunto (bucket privado contratista-docs) ──
const DNI_BUCKET = 'contratista-docs'
const DNI_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
])
const DNI_MAX_BYTES = 10 * 1024 * 1024
function dniExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
  }
  return map[mime] ?? 'bin'
}
async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
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
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: UpdateContratistaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('contratistas')
      .update({ ...dto, updated_by: userId })
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
    const prevPath = (prev as { dni_doc_path?: string | null } | null)?.dni_doc_path
    if (prevPath) {
      await supabaseAdmin.storage.from(DNI_BUCKET).remove([prevPath]).catch(() => undefined)
    }
    return { success: true }
  },

  // ── DNI adjunto (foto/PDF, bucket contratista-docs) ───────────
  // Flujo de 2 pasos (calcado de vehiculo-docs): signed upload URL → el
  // cliente sube el archivo → registrar el storage_path en el contratista.
  async dniUploadUrl(contratId: number, dto: DniUploadUrlDto) {
    if (!DNI_ALLOWED_MIME.has(dto.mime_type)) {
      throw new HTTPException(400, { message: 'Tipo de archivo no permitido (foto o PDF)' })
    }
    if (dto.size_bytes <= 0 || dto.size_bytes > DNI_MAX_BYTES) {
      throw new HTTPException(400, { message: 'Archivo demasiado grande (máx 10 MB)' })
    }
    const ext  = dniExtFromMime(dto.mime_type)
    const path = `contratista/${contratId}/${randomUUID()}.${ext}`
    const { data, error } = await supabaseAdmin.storage.from(DNI_BUCKET).createSignedUploadUrl(path)
    if (error) throw new HTTPException(500, { message: error.message })
    return { path, token: data.token, signed_url: data.signedUrl }
  },

  async dniRegistrar(contratId: number, dto: DniRegistrarDto, userId: string, token: string) {
    if (!dto.storage_path.startsWith(`contratista/${contratId}/`)) {
      throw new HTTPException(400, { message: 'Path inválido' })
    }
    const dl = await supabaseAdmin.storage.from(DNI_BUCKET).download(dto.storage_path)
    if (dl.error || !dl.data) {
      throw new HTTPException(400, { message: 'El archivo no se subió correctamente' })
    }
    const hash = await sha256OfBlob(dl.data)

    const supabase = createSupabaseClient(token)
    const { data: prev } = await supabase
      .from('contratistas').select('dni_doc_path').eq('id', contratId).single()

    const { data, error } = await supabase
      .from('contratistas')
      .update({
        dni_doc_path:   dto.storage_path,
        dni_doc_nombre: dto.nombre_archivo,
        dni_doc_mime:   dto.mime_type,
        dni_doc_size:   dl.data.size,
        dni_doc_hash:   hash,
        updated_by:     userId,
      })
      .eq('id', contratId)
      .select()
      .single()
    if (error) throw new HTTPException(500, { message: error.message })

    const prevPath = (prev as { dni_doc_path?: string | null } | null)?.dni_doc_path
    if (prevPath && prevPath !== dto.storage_path) {
      await supabaseAdmin.storage.from(DNI_BUCKET).remove([prevPath]).catch(() => undefined)
    }
    return data
  },

  async dniSignedUrl(contratId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data: c, error } = await supabase
      .from('contratistas')
      .select('dni_doc_path, dni_doc_nombre')
      .eq('id', contratId)
      .single()
    if (error) throw new HTTPException(500, { message: error.message })
    if (!c?.dni_doc_path) {
      throw new HTTPException(404, { message: 'El contratista no tiene DNI adjunto' })
    }
    const { data, error: sErr } = await supabaseAdmin.storage
      .from(DNI_BUCKET)
      .createSignedUrl(c.dni_doc_path, 900, { download: c.dni_doc_nombre ?? undefined })
    if (sErr) throw new HTTPException(500, { message: sErr.message })
    return { url: data.signedUrl, nombre_archivo: c.dni_doc_nombre }
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
    if (error) throw new HTTPException(500, { message: error.message })

    const prevPath = (prev as { dni_doc_path?: string | null } | null)?.dni_doc_path
    if (prevPath) {
      await supabaseAdmin.storage.from(DNI_BUCKET).remove([prevPath]).catch(() => undefined)
    }
    return data
  },

  // ── Asignaciones a obras ──
  async getAsigByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asig_contrat')
      .select('*, contratistas(*)')
      .eq('obra_cod', obraCod)

    if (error) throw new Error(error.message)
    return data
  },

  async asignar(dto: AsigContratistaDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('asig_contrat')
      .insert({ ...dto, created_by: userId, updated_by: userId })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },

  async desasignar(obraCod: string, contratId: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase
      .from('asig_contrat')
      .delete()
      .eq('obra_cod', obraCod)
      .eq('contrat_id', contratId)

    if (error) throw new Error(error.message)
    return { success: true }
  },

  // ── Certificaciones ──
  async getCertByObra(obraCod: string, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('certificaciones')
      .select('*')
      .eq('obra_cod', obraCod)
      .order('sem_key', { ascending: false })

    if (error) throw new Error(error.message)
    return data
  },

  async upsertCert(dto: CertificacionDto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('certificaciones')
      .upsert(
        { ...dto, created_by: userId, updated_by: userId },
        { onConflict: 'obra_cod,contrat_id,sem_key' }
      )
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data
  },
}
