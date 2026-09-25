/**
 * Datos de la empresa (tanda 6, 20260929a): la única fuente del CUIT, los
 * defaults (idénticos a la semilla y a lo que imprimen hoy los PDF), la caché
 * y el fallback cuando la base no responde.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  CUIT_EMPRESA, cuitFmt, empresaDefault, empresaDesdeJson, conSistema, getEmpresa, invalidarEmpresa,
} from '../../src/lib/empresa.js'
import { CUIT_EMISOR } from '../../src/modules/facturacion/reglas.js'
import { CUIT_CADINC as CUIT_LECTURA } from '../../src/modules/pagos/lectura/arca.js'
import { sistema as sistemaFactura } from '../../src/modules/pagos/lectura/ia.js'
import { sistema as sistemaCheque } from '../../src/modules/pagos/lectura/cheque-ia.js'
import { EmpresaPatchSchema } from '../../src/modules/empresa/empresa.service.js'

describe('CUIT de la empresa', () => {
  it('sin ARCA_CUIT es el de CADINC, y todos los alias apuntan al mismo', () => {
    expect(CUIT_EMPRESA).toBe('33717191949')
    expect(CUIT_EMISOR).toBe(CUIT_EMPRESA)
    expect(CUIT_LECTURA).toBe(CUIT_EMPRESA)
  })
  it('cuitFmt', () => {
    expect(cuitFmt('33717191949')).toBe('33-71719194-9')
    expect(cuitFmt('123')).toBe('123')
  })
})

describe('defaults = lo que imprimen hoy los PDF', () => {
  const d = empresaDefault()
  it('textos del encabezado', () => {
    expect(d.razon_social).toBe('CADINC S.R.L.')
    expect(d.nombre_fantasia).toBe('CADINC SRL')
    expect(d.cuit_fmt).toBe('33-71719194-9')
    expect(d.condicion_iva).toBe('Responsable Inscripto')
    expect(d.iibb).toBe('33-71719194-9')
    expect(d.inicio_actividades).toBe('2021-07-01')
    expect(d.domicilio).toBe('Maipú 396, Dpto. 3 — San Miguel de Tucumán, Tucumán')
    expect(d.domicilio_factura_1).toBe('Maipú 396 3 – San Miguel de Tucumán')
    expect(d.domicilio_factura_2).toBe('(4000) Tucumán Argentina')
  })
  it('conSistema compara contra ARCA_CUIT', () => {
    expect(conSistema(d).cuit_sistema).toEqual({ arca_cuit: '33717191949', coincide: true })
    expect(conSistema({ ...d, cuit: '20111111112' }).cuit_sistema.coincide).toBe(false)
  })
  it('empresaDesdeJson completa lo que falta con los defaults', () => {
    const e = empresaDesdeJson({ razon_social: 'OTRA S.A.', inicio_actividades: null })
    expect(e.razon_social).toBe('OTRA S.A.')
    expect(e.cuit).toBe('33717191949')
    expect(e.inicio_actividades).toBeNull()
    expect(empresaDesdeJson(null)).toEqual(empresaDefault())
  })
})

describe('getEmpresa', () => {
  beforeEach(() => invalidarEmpresa())

  it('lee la RPC y cachea 60 s', async () => {
    const rpc = vi.fn(async () => ({ data: { ...empresaDefault(), razon_social: 'DESDE LA BASE' }, error: null }))
    const db = { rpc } as any
    expect((await getEmpresa(db)).razon_social).toBe('DESDE LA BASE')
    expect((await getEmpresa(db)).razon_social).toBe('DESDE LA BASE')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('empresa_config_json')
    invalidarEmpresa()
    await getEmpresa(db)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('si la base falla devuelve los defaults y no cachea', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'relation does not exist' } }))
    expect(await getEmpresa({ rpc } as any)).toEqual(empresaDefault())
    await getEmpresa({ rpc } as any)
    expect(rpc).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('prompts de la lectura IA', () => {
  it('con los defaults dicen lo mismo que el literal de antes', () => {
    const d = empresaDefault()
    expect(sistemaFactura(d)).toContain('para la contabilidad de CADINC S.R.L. (CUIT 33-71719194-9), que es la empresa que COMPRA.')
    expect(sistemaCheque(d)).toContain('para la tesorería de CADINC S.R.L. (CUIT 33-71719194-9), que los ENTREGA')
  })
  it('toman la razón social de la empresa', () => {
    expect(sistemaFactura({ razon_social: 'OTRA S.A.', cuit_fmt: '30-11111111-1' })).toContain('OTRA S.A. (CUIT 30-11111111-1)')
  })
})

describe('PATCH /api/empresa: schema', () => {
  it('rechaza el CUIT y las claves desconocidas', () => {
    const r = EmpresaPatchSchema.safeParse({ cuit: '20111111112' })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.code).toBe('unrecognized_keys')
    expect(EmpresaPatchSchema.safeParse({ foo: 1 }).success).toBe(false)
  })
  it('acepta un parcial y email vacío', () => {
    expect(EmpresaPatchSchema.safeParse({ telefono: '381 555', email: '' }).success).toBe(true)
    expect(EmpresaPatchSchema.safeParse({ email: 'no-es-mail' }).success).toBe(false)
    expect(EmpresaPatchSchema.safeParse({ razon_social: 'AB' }).success).toBe(false)
  })
})
