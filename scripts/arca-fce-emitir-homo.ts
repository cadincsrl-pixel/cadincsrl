/**
 * Prueba de punta a punta de la FCE MiPyME en HOMOLOGACIÓN (fase 6,
 * 2026-09-23): arma borradores con los mismos services que usa la API
 * (guardar → emitir, con el TA en arca_tokens y el XML en el log) y emite:
 *   1. una FCE A (201) ≥ monto mínimo al receptor de prueba;
 *   2. una NC FCE (203) parcial (opcional 22 = N);
 *   3. una NC FCE (203) de anulación (22 = S) por el saldo.
 *
 *   npx tsx scripts/arca-fce-emitir-homo.ts --cliente=2 --user=<uuid admin>
 *
 * SOLO homologación: se niega a correr con otro ARCA_AMBIENTE.
 */
import 'dotenv/config'
import { supabase } from '../src/lib/supabase.js'
import { facturasService } from '../src/modules/facturacion/facturas.service.js'
import { emisionService, iniciarArca } from '../src/modules/facturacion/emision.service.js'
import { FacturacionHttpError } from '../src/modules/facturacion/facturacion.errors.js'
import type { FJ } from '../src/modules/facturacion/reglas.js'

if ((process.env.ARCA_AMBIENTE ?? '').trim() !== 'homo') {
  console.error('Este script corre SOLO con ARCA_AMBIENTE=homo.')
  process.exit(1)
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=')
  return [k, v.join('=')]
}))
const CLIENTE = Number(args.cliente || 2)
const USER = args.user || 'a7d0ea6b-0bec-4ac0-bfc8-ef6262743dd8'
const CC = args.cc || 'ARCOR'
const SOLO = args.solo // '201' | 'nc'
const FACTURA = args.factura ? Number(args.factura) : null

iniciarArca(supabase)

function resumen(fj: FJ): string {
  const f = fj.factura
  return `#${f.id} tipo ${f.cbte_tipo} ${f.estado} N° ${f.numero_fmt ?? '-'} CAE ${f.cae ?? '-'} vto CAE ${f.cae_vto ?? '-'} total ${f.imp_total}`
}

async function emitir(id: number): Promise<FJ | null> {
  try {
    const fj = await emisionService.emitir(id, USER, false, supabase)
    console.log('  AUTORIZADA', resumen(fj))
    return fj
  } catch (e) {
    if (e instanceof FacturacionHttpError) {
      console.log(`  ${e.status} ${e.code}`, JSON.stringify(e.detail))
      const f = (e.extra?.factura as FJ | undefined)
      if (f) console.log('  ', resumen(f))
      return null
    }
    throw e
  }
}

async function main(): Promise<void> {
  let facturaId = FACTURA
  let total = 0
  if (!facturaId && SOLO !== 'nc') {
    console.log('1. FCE A (201) por $ 6.050.000 (neto 5.000.000 + IVA 21 %)')
    const fj = await facturasService.guardar({
      factura: {
        cbte_tipo: 201, cliente_id: CLIENTE, producto: 'AVANCE DE OBRA', centro_costo: CC,
        fce_transmision: 'SCA', fce_referencia: '4500278113', observaciones: 'Prueba FCE homologación',
      },
      renglones: [{ descripcion: 'Avance de obra — prueba FCE MiPyME (homologación)', cantidad: 1, precio_unit: 5_000_000, alicuota_id: 5 }],
      forzar: false,
    } as never, null, USER, true, supabase)
    console.log('  borrador', resumen(fj), 'cbu', fj.factura.fce_cbu, 'vto pago', fj.factura.fch_vto_pago)
    const ok = await emitir(fj.factura.id)
    if (!ok) return
    facturaId = ok.factura.id
    total = Number(ok.factura.imp_total)
  }
  if (SOLO === '201' || !facturaId) return
  if (!total) total = Number((await facturasService.detalle(facturaId, supabase)).factura.imp_total)

  console.log('2. NC FCE (203) parcial por $ 1.210.000, anulación N')
  const nc1 = await facturasService.guardar({
    factura: { cbte_tipo: 203, cliente_id: CLIENTE, producto: 'AVANCE DE OBRA', centro_costo: CC, asociada_id: facturaId, nc_anulacion: 'N' },
    renglones: [{ descripcion: 'Descuento parcial — prueba NC FCE', cantidad: 1, precio_unit: 1_000_000, alicuota_id: 5 }],
    forzar: false,
  } as never, null, USER, true, supabase)
  await emitir(nc1.factura.id)

  const saldoNeto = Math.round((total - 1_210_000) / 1.21 * 100) / 100
  console.log(`3. NC FCE (203) de anulación por el saldo (neto ${saldoNeto}), anulación S`)
  const nc2 = await facturasService.guardar({
    factura: { cbte_tipo: 203, cliente_id: CLIENTE, producto: 'AVANCE DE OBRA', centro_costo: CC, asociada_id: facturaId, nc_anulacion: 'S' },
    renglones: [{ descripcion: 'Anulación — prueba NC FCE', cantidad: 1, precio_unit: saldoNeto, alicuota_id: 5 }],
    forzar: false,
  } as never, null, USER, true, supabase)
  await emitir(nc2.factura.id)
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof FacturacionHttpError ? `${e.status} ${e.code} ${JSON.stringify(e.detail)}` : e)
  process.exit(1)
})
