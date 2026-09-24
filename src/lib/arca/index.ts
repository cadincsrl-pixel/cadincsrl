/**
 * Conexión con ARCA (ex AFIP) para factura electrónica. Ver cada archivo:
 * - config.ts  variables de entorno y URLs por ambiente
 * - wsaa.ts    ticket de acceso (TA) con persistencia y reclamo de renovación
 * - wsfe.ts    WSFEv1: último autorizado, CAE, consulta, parámetros
 * - wsfecred.ts WSFECRED: ¿el receptor está obligado a recibir FCE MiPyME?
 * - errores.ts ArcaError y la distinción "no llegó" / "quizás llegó"
 */
export * from './errores.js'
export * from './config.js'
export {
  type TicketAcceso, type TaStore, MARGEN_VENCIMIENTO_MS,
  taVigente, armarTRA, firmarTRA, parsearLoginCms, loginCms,
  crearTaStoreSupabase, configurarTaStore, obtenerTA, olvidarTA,
} from './wsaa.js'
export * from './wsfe.js'
export * from './wsfecred.js'
