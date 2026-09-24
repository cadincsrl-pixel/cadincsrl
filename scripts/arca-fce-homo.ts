/**
 * WSFECRED en homologación: ¿el receptor está obligado a recibir FCE MiPyME?
 * (fase 6, 2026-09-23). SOLO homologación: se niega a correr con otro
 * ambiente.
 *
 *   npx tsx scripts/arca-fce-homo.ts                       ARCOR (30502793175) y el cliente de prueba (20111111112)
 *   npx tsx scripts/arca-fce-homo.ts --cuit=30500010084    uno en particular
 *   npx tsx scripts/arca-fce-homo.ts --fixtures            guarda las respuestas en tests/lib/arca/fixtures/
 *
 * El ticket de WSAA del servicio `wsfecred` se guarda en `arca_tokens` (el
 * mismo store que usa el servidor) y, por las dudas, una copia en
 * ~/.config/cadinc-env/arca/ta-wsfecred-homo.xml ANTES de guardarlo en la
 * base: ARCA no da otro por ~12 h.
 *
 * Nunca imprime certificado, clave, token ni sign.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { supabase } from '../src/lib/supabase.js'
import {
  arcaConfig, configurarTaStore, crearTaStoreSupabase, obtenerTA,
  NS_WSFECRED, SERVICIO_WSFECRED, parsearMontoObligado, sobreMontoObligado,
} from '../src/lib/arca/index.js'
import { postSoap } from '../src/lib/arca/soap.js'

if ((process.env.ARCA_AMBIENTE ?? '').trim() !== 'homo') {
  console.error('Este script corre SOLO con ARCA_AMBIENTE=homo.')
  process.exit(1)
}

const args = process.argv.slice(2)
const FIXTURES = args.includes('--fixtures')
const cuitArg = args.find((a) => a.startsWith('--cuit='))?.split('=')[1]
const CUITS = cuitArg ? [cuitArg] : ['30502793175', '20111111112']
const REPRESENTADA = args.find((a) => a.startsWith('--representada='))?.split('=')[1]
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
    console.log(`TA de ${servicio} guardado en arca_tokens (vence ${ta.expiraAt.toISOString()})`)
  },
})

async function main(): Promise<void> {
  const cfg = arcaConfig()
  const hoy = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
  const ta = await obtenerTA(SERVICIO_WSFECRED, { config: cfg })
  console.log(`Ambiente ${cfg.ambiente}, ${cfg.urls.wsfecred}, TA vence ${ta.expiraAt.toISOString()}`)

  for (const cuit of CUITS) {
    const { status, xml } = await postSoap({
      url: cfg.urls.wsfecred,
      soapAction: `${NS_WSFECRED}consultarMontoObligadoRecepcion`,
      sobre: sobreMontoObligado(ta, REPRESENTADA ?? cfg.cuit, cuit, hoy),
      contexto: 'WSFECRED consultarMontoObligadoRecepcion',
    })
    if (FIXTURES) {
      mkdirSync(DIR_FX, { recursive: true })
      const f = path.join(DIR_FX, `consultarMontoObligadoRecepcion-${cuit}.xml`)
      writeFileSync(f, xml)
      console.log(`  fixture → ${f}`)
    }
    try {
      const r = parsearMontoObligado(xml, status)
      console.log(`${cuit} (${hoy}): obligado=${r.obligado} montoDesde=${r.montoDesde}`, r.observaciones.length ? r.observaciones : '')
    } catch (e) {
      console.log(`${cuit}: ERROR ${e instanceof Error ? e.message : e}`)
    }
  }
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
