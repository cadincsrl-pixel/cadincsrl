/**
 * Siembra en `arca_tokens` un TA (ticket de acceso de WSAA) que ya existe en
 * un archivo, vía la RPC `arca_guardar_token` (20260924c).
 *
 *   npx tsx scripts/arca-sembrar-ta.ts                      homo / wsfe desde ~/.config/cadinc-env/arca/ta-wsfe-homo.xml
 *   npx tsx scripts/arca-sembrar-ta.ts --archivo=/ruta.xml --ambiente=homo --servicio=wsfe
 *
 * Para qué: WSAA NO entrega otro TA mientras el anterior siga vigente
 * (coe.alreadyAuthenticated). Si el TA se pidió fuera del servidor (script de
 * humo, curl), el backend no lo tiene y no puede pedir otro hasta que venza:
 * esto se lo pasa. El archivo es el loginTicketResponse (o el XML que guarda
 * scripts/arca-humo.ts).
 *
 * Nunca imprime token ni sign. Lee SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY del .env.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { supabase } from '../src/lib/supabase.js'
import { parsearXml, nodo, texto } from '../src/lib/arca/soap.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=')
  return [k, v.join('=')]
}))
const ambiente = args.ambiente || 'homo'
const servicio = args.servicio || 'wsfe'
const archivo = args.archivo || path.join(homedir(), `.config/cadinc-env/arca/ta-${servicio}-${ambiente}.xml`)

async function main() {
  if (ambiente !== 'homo' && ambiente !== 'prod') throw new Error('--ambiente tiene que ser homo o prod')
  const doc = parsearXml(readFileSync(archivo, 'utf8'))
  // Acepta el loginTicketResponse suelto o la respuesta SOAP de loginCms.
  let t = nodo(doc.loginTicketResponse)
  if (!t) {
    const interno = texto(nodo(nodo(nodo(doc.Envelope)?.Body)?.loginCmsResponse)?.loginCmsReturn)
    t = interno ? nodo(parsearXml(interno).loginTicketResponse) : undefined
  }
  const token = texto(nodo(t?.credentials)?.token)
  const sign = texto(nodo(t?.credentials)?.sign)
  const expira = new Date(texto(nodo(t?.header)?.expirationTime))
  const generado = new Date(texto(nodo(t?.header)?.generationTime))
  if (!token || !sign || Number.isNaN(expira.getTime())) throw new Error(`${archivo}: no trae token, sign o expirationTime`)
  if (expira.getTime() <= Date.now()) throw new Error(`el TA de ${archivo} ya venció (${expira.toISOString()})`)

  const { error } = await supabase.rpc('arca_guardar_token', {
    p_ambiente: ambiente,
    p_servicio: servicio,
    p_token: token,
    p_sign: sign,
    p_generado_at: Number.isNaN(generado.getTime()) ? null : generado.toISOString(),
    p_expira_at: expira.toISOString(),
  })
  if (error) throw new Error(`arca_guardar_token: ${error.message}`)

  const { data } = await supabase.from('arca_tokens').select('ambiente, servicio, generado_at, expira_at, renovando_hasta')
    .eq('ambiente', ambiente).eq('servicio', servicio).maybeSingle()
  console.log('✓ TA sembrado en arca_tokens:', data)
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e)
  process.exit(1)
})
