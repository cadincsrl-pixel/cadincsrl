/**
 * Prueba de humo de la conexión con ARCA, SOLO en homologación.
 *
 *   npx tsx scripts/arca-humo.ts                 FEDummy → condiciones IVA A → tipos IVA → último FA PV3
 *   npx tsx scripts/arca-humo.ts --emitir        … y además emite UNA Factura A de prueba y la consulta
 *   npx tsx scripts/arca-humo.ts --fixtures      guarda las respuestas en tests/lib/arca/fixtures/
 *   --receptor=20111111112                       CUIT del receptor de prueba
 *
 * Toma la config de las ARCA_* del entorno; si faltan, usa las de homologación
 * locales (~/.config/cadinc-env/arca/homo.{crt,key}). No toca ningún .env.
 *
 * El TA vive en ~/.config/cadinc-env/arca/ta-wsfe-homo.xml (store de archivo):
 * mientras esté vigente se reusa y NO se pide otro a WSAA, porque ARCA
 * responde alreadyAuthenticated.
 *
 * Nunca imprime certificado, clave, token ni sign.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  arcaConfig, configurarTaStore, obtenerTA, configurarTrazaXml, taVigente,
  feDummy, paramCondicionIvaReceptor, paramTiposIva, ultimoAutorizado, solicitarCAE, consultarComprobante,
  ArcaError, type TaStore, type TicketAcceso,
} from '../src/lib/arca/index.js'
import { parsearXml, nodo, texto } from '../src/lib/arca/soap.js'

// La config de ARCA se lee al usarse, no al importarse: alcanza con completar
// el entorno antes de llamar a arcaConfig().

const DIR_ARCA = path.join(homedir(), '.config/cadinc-env/arca')
process.env.ARCA_AMBIENTE ??= 'homo'
if (!process.env.ARCA_CERT_B64 && !process.env.ARCA_CERT_PATH) process.env.ARCA_CERT_PATH = path.join(DIR_ARCA, 'homo.crt')
if (!process.env.ARCA_KEY_B64 && !process.env.ARCA_KEY_PATH) process.env.ARCA_KEY_PATH = path.join(DIR_ARCA, 'homo.key')


const args = process.argv.slice(2)
const EMITIR = args.includes('--emitir')
const FIXTURES = args.includes('--fixtures')
const RECEPTOR = args.find((a) => a.startsWith('--receptor='))?.split('=')[1] ?? '20111111112'

const cfg = arcaConfig()
if (cfg.ambiente !== 'homo') {
  console.error('✗ Este script corre SOLO en homologación (ARCA_AMBIENTE=homo).')
  process.exit(1)
}

// ─── Store de archivo ────────────────────────────────────────────────────────
function archivoTA(amb: string, srv: string) {
  return path.join(DIR_ARCA, `ta-${srv}-${amb}.xml`)
}
const storeArchivo: TaStore = {
  async leer(amb, srv) {
    const f = archivoTA(amb, srv)
    if (!existsSync(f)) return null
    const t = nodo(parsearXml(readFileSync(f, 'utf8')).loginTicketResponse)
    const token = texto(nodo(t?.credentials)?.token)
    const sign = texto(nodo(t?.credentials)?.sign)
    const expiraAt = new Date(texto(nodo(t?.header)?.expirationTime))
    return token && sign && !Number.isNaN(expiraAt.getTime()) ? { token, sign, expiraAt } : null
  },
  async reclamarRenovacion() {
    return true // un solo proceso
  },
  async guardar(amb, srv, ta: TicketAcceso) {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<loginTicketResponse version="1.0">\n' +
      `  <header>\n    <expirationTime>${ta.expiraAt.toISOString()}</expirationTime>\n  </header>\n` +
      `  <credentials>\n    <token>${ta.token}</token>\n    <sign>${ta.sign}</sign>\n  </credentials>\n` +
      '</loginTicketResponse>\n'
    writeFileSync(archivoTA(amb, srv), xml, { mode: 0o600 })
  },
}
configurarTaStore(storeArchivo)

// ─── Fixtures ────────────────────────────────────────────────────────────────
const DIR_FIX = path.join(process.cwd(), 'tests/lib/arca/fixtures')
const capturas = new Map<string, string>()
configurarTrazaXml(({ metodo, respuesta }) => {
  if (respuesta) capturas.set(metodo, respuesta)
})
function guardarFixture(nombre: string, metodo: string) {
  const xml = capturas.get(metodo)
  if (!FIXTURES || !xml) return
  mkdirSync(DIR_FIX, { recursive: true })
  writeFileSync(path.join(DIR_FIX, nombre), xml)
  console.log(`   fixture → tests/lib/arca/fixtures/${nombre}`)
}

// ─── Humo ────────────────────────────────────────────────────────────────────
function hoyArgentina(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '')
}

async function main() {
  console.log(`ARCA ${cfg.ambiente} · CUIT ${cfg.cuit} · PV ${cfg.ptoVta}`)

  const dummy = await feDummy()
  console.log('1. FEDummy', dummy)
  guardarFixture('FEDummy.xml', 'FEDummy')

  const guardado = await storeArchivo.leer(cfg.ambiente, 'wsfe')
  console.log(`   TA en archivo: ${taVigente(guardado) ? `vigente hasta ${guardado!.expiraAt.toISOString()}` : 'vencido o ausente (se pide uno nuevo)'}`)
  const ta = await obtenerTA('wsfe')
  console.log(`   TA en uso vence ${ta.expiraAt.toISOString()}`)

  const conds = await paramCondicionIvaReceptor('A')
  console.log('2. Condiciones IVA receptor clase A:', conds.map((c) => `${c.id} ${c.descripcion}`).join(' · '))
  guardarFixture('FEParamGetCondicionIvaReceptor-A.xml', 'FEParamGetCondicionIvaReceptor')

  const ivas = await paramTiposIva()
  console.log('   Tipos IVA:', ivas.map((t) => `${t.id}=${t.descripcion}`).join(' · '))
  guardarFixture('FEParamGetTiposIva.xml', 'FEParamGetTiposIva')

  const ult = await ultimoAutorizado(cfg.ptoVta, 1)
  console.log(`3. Último autorizado PV${ult.ptoVta} tipo ${ult.cbteTipo}: ${ult.numero}`)
  guardarFixture('FECompUltimoAutorizado.xml', 'FECompUltimoAutorizado')

  let aConsultar = ult.numero
  if (EMITIR) {
    const hoy = hoyArgentina()
    const numero = ult.numero + 1
    console.log(`4. FECAESolicitar Factura A ${cfg.ptoVta}-${numero} a CUIT ${RECEPTOR}, neto 100 + IVA 21`)
    const r = await solicitarCAE({
      ptoVta: cfg.ptoVta, cbteTipo: 1, numero, concepto: 3,
      docTipo: 80, docNro: RECEPTOR, cbteFch: hoy,
      impNeto: 100, impIva: 21, impTotal: 121, impTotConc: 0, impOpEx: 0, impTrib: 0,
      fchServDesde: hoy, fchServHasta: hoy, fchVtoPago: hoy,
      monId: 'PES', monCotiz: 1, condicionIvaReceptorId: 1,
      iva: [{ id: 5, baseImp: 100, importe: 21 }],
    })
    console.log('   Resultado:', JSON.stringify(r, null, 2))
    guardarFixture(r.resultado === 'A' ? 'FECAESolicitar-A.xml' : 'FECAESolicitar-R.xml', 'FECAESolicitar')
    if (r.resultado === 'A') aConsultar = numero
  }

  if (aConsultar > 0) {
    const c = await consultarComprobante(cfg.ptoVta, 1, aConsultar)
    console.log(`5. FECompConsultar ${cfg.ptoVta}-1-${aConsultar}:`, JSON.stringify(c, null, 2))
    guardarFixture('FECompConsultar.xml', 'FECompConsultar')
  }
  console.log('✓ Humo OK')
}

main().catch((e: unknown) => {
  if (e instanceof ArcaError) {
    console.error(`✗ ${e.codigo} [${e.tipo}${e.quizasLlego ? ', QUIZÁS LLEGÓ' : ''}] ${e.message}`)
    if (e.errores.length) console.error('  errores ARCA:', e.errores)
  } else {
    console.error('✗', e instanceof Error ? e.message : e)
  }
  process.exit(1)
})
