/**
 * Completa el domicilio y la provincia de los clientes de Facturación con el
 * padrón de ARCA (fase 7, 2026-09-23). Es una CONSULTA de padrón
 * (ws_sr_constancia_inscripcion / getPersona_v2): no emite ni registra nada
 * en ARCA. Este script NO importa nada de WSFE.
 *
 *   npx tsx scripts/arca-completar-domicilios.ts                 simulación: muestra qué cambiaría
 *   npx tsx scripts/arca-completar-domicilios.ts --aplicar       guarda domicilio, provincia y padron_json
 *   npx tsx scripts/arca-completar-domicilios.ts --cuit=30502793175,20111111112   solo consulta y muestra
 *   … --cuit=… --fixtures        guarda las respuestas crudas en tests/lib/arca/fixtures/ (REDACTARLAS antes de commitear)
 *
 * Qué clientes: `ventas_clientes` activos, doc_tipo 80 y domicilio vacío.
 * Qué toca: SOLO domicilio y provincia (+ padron_json / padron_consultado_at).
 * Razón social y condición de IVA NO se tocan; si ARCA dice otra condición,
 * se reporta.
 *
 * Ambiente: el de ARCA_AMBIENTE. Para producción:
 *   ARCA_AMBIENTE=prod ARCA_CERT_PATH=~/.config/cadinc-env/arca/prod.crt \
 *   ARCA_KEY_PATH=~/.config/cadinc-env/arca/prod.key npx tsx scripts/arca-completar-domicilios.ts
 * (dotenv no pisa variables ya definidas.)
 *
 * El ticket de WSAA del servicio se guarda en `arca_tokens` (el mismo store
 * que usa Render) y, ANTES, una copia en
 * ~/.config/cadinc-env/arca/ta-ws_sr_constancia_inscripcion-<amb>.xml: ARCA
 * no da otro por ~12 h. Nunca imprime certificado, clave, token ni sign.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { supabase } from '../src/lib/supabase.js'
import {
  ArcaError, arcaConfig, configurarTaStore, crearTaStoreSupabase, obtenerTA,
  SERVICIO_PADRON, parsearGetPersona, sobreGetPersona, type PersonaPadron,
} from '../src/lib/arca/index.js'
import { postSoap } from '../src/lib/arca/soap.js'
import { domicilioDePadron, padronJson } from '../src/modules/facturacion/padron.service.js'
import { CONDICIONES_IVA } from '../src/modules/facturacion/reglas.js'

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')
const FIXTURES = args.includes('--fixtures')
const cuitArg = args.find((a) => a.startsWith('--cuit='))?.split('=')[1]
const DIR_FX = path.join(process.cwd(), 'tests/lib/arca/fixtures')

const base = crearTaStoreSupabase(supabase)
configurarTaStore({
  ...base,
  async guardar(amb, servicio, ta) {
    const archivo = path.join(homedir(), `.config/cadinc-env/arca/ta-${servicio}-${amb}.xml`)
    writeFileSync(archivo,
      `<loginTicketResponse><header><generationTime>${ta.generadoAt?.toISOString() ?? ''}</generationTime>` +
      `<expirationTime>${ta.expiraAt.toISOString()}</expirationTime></header>` +
      `<credentials><token>${ta.token}</token><sign>${ta.sign}</sign></credentials></loginTicketResponse>`,
      { mode: 0o600 })
    console.log(`TA de ${servicio} copiado a ${archivo}`)
    await base.guardar(amb, servicio, ta)
    console.log(`TA de ${servicio} (${amb}) guardado en arca_tokens (vence ${ta.expiraAt.toISOString()})`)
  },
})

const condNom = (id: number | null) => (id == null ? '—' : `${id} ${CONDICIONES_IVA.find((c) => c.id === id)?.descripcion ?? '?'}`)

async function consultar(cuit: string): Promise<PersonaPadron> {
  const cfg = arcaConfig()
  const ta = await obtenerTA(SERVICIO_PADRON, { config: cfg })
  const { status, xml } = await postSoap({
    url: cfg.urls.padron, soapAction: '', sobre: sobreGetPersona(ta, cfg.cuit, cuit),
    contexto: 'Padrón getPersona_v2', timeoutMs: 20_000,
  })
  if (FIXTURES) {
    mkdirSync(DIR_FX, { recursive: true })
    const f = path.join(DIR_FX, `getPersona_v2-${cfg.ambiente}-${cuit}.xml`)
    writeFileSync(f, xml)
    console.log(`  fixture → ${f}`)
  }
  return parsearGetPersona(xml, cuit, status)
}

const motivo = (e: unknown) => (e instanceof ArcaError ? `${e.codigo}: ${e.message}` : e instanceof Error ? e.message : String(e))

async function main(): Promise<void> {
  const cfg = arcaConfig()
  console.log(`Ambiente ${cfg.ambiente} · ${cfg.urls.padron} · representada ${cfg.cuit}`)

  if (cuitArg) {
    for (const cuit of cuitArg.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        const p = await consultar(cuit)
        console.log(`\n${cuit}:`, JSON.stringify({ ...p, ...domicilioDePadron(p) }, null, 2))
      } catch (e) {
        console.log(`\n${cuit}: ERROR ${motivo(e)}`)
      }
    }
    return
  }

  const { data, error } = await supabase.from('ventas_clientes')
    .select('id, razon_social, doc_nro, condicion_iva_id, domicilio, provincia')
    .eq('activo', true).eq('doc_tipo', 80).order('id')
  if (error) throw new Error(error.message)
  const clientes = (data ?? []).filter((c) => !String(c.domicilio ?? '').trim())
  console.log(`${clientes.length} clientes activos con CUIT y sin domicilio${APLICAR ? '' : ' (SIMULACIÓN: agregá --aplicar para guardar)'}\n`)

  const ok: string[] = []
  const fallas: string[] = []
  const difIva: string[] = []
  for (const c of clientes) {
    const quien = `#${c.id} ${c.razon_social} (${c.doc_nro})`
    let p: PersonaPadron
    try {
      p = await consultar(String(c.doc_nro))
    } catch (e) {
      fallas.push(`${quien}: ${motivo(e)}`)
      console.log(`✗ ${quien}: ${motivo(e)}`)
      continue
    }
    const { domicilio, provincia } = domicilioDePadron(p)
    if (p.condicion_iva_id !== Number(c.condicion_iva_id)) {
      difIva.push(`${quien}: cargada ${condNom(Number(c.condicion_iva_id))} · ARCA ${condNom(p.condicion_iva_id)}${p.condicion_iva_dudosa ? ' (dudosa)' : ''} — ${p.condicion_iva_motivo}`)
    }
    if (p.razon_social && p.razon_social.trim().toUpperCase() !== String(c.razon_social).trim().toUpperCase()) {
      console.log(`  (razón social en ARCA: «${p.razon_social}», no se toca)`)
    }
    if (!domicilio) {
      fallas.push(`${quien}: ARCA no trae domicilio fiscal`)
      console.log(`✗ ${quien}: ARCA no trae domicilio fiscal`)
      continue
    }
    const ahora = new Date().toISOString()
    if (APLICAR) {
      const { error: e2 } = await supabase.from('ventas_clientes').update({
        domicilio, provincia: provincia || c.provincia,
        padron_json: padronJson(p, ahora), padron_consultado_at: ahora,
      }).eq('id', c.id).eq('domicilio', c.domicilio ?? '')
      if (e2) {
        fallas.push(`${quien}: no se pudo guardar (${e2.message})`)
        console.log(`✗ ${quien}: no se pudo guardar (${e2.message})`)
        continue
      }
    }
    ok.push(`${quien}: ${domicilio} · ${provincia}`)
    console.log(`✓ ${quien}: ${domicilio} · ${provincia}`)
  }

  console.log(`\n── Resumen (${cfg.ambiente}${APLICAR ? '' : ', simulación'}) ──`)
  console.log(`Completados: ${ok.length}`)
  console.log(`Sin completar: ${fallas.length}`)
  for (const f of fallas) console.log(`  · ${f}`)
  console.log(`Condición de IVA distinta (NO se cambió): ${difIva.length}`)
  for (const d of difIva) console.log(`  · ${d}`)
}

main().then(() => process.exit(0), (e) => {
  console.error('✗', motivo(e))
  process.exit(1)
})
