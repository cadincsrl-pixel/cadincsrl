# CLAUDE.md — Backend `cadincsrl`

> Contexto operativo del backend del ERP CADINC SRL. Leer completo antes de escribir código.
> Repo hermano: `/Users/francoleiro/frontend_cadinc_gestion` (frontend Next.js).

---

## 1. Qué es esto

API REST del ERP interno de **CADINC SRL** (empresa argentina de construcción y logística). Expone los endpoints que consume el frontend Next.js y actúa como **gateway autenticado** a Supabase.

Arquitectura:
```
Frontend Next.js  →  este backend Hono  →  Supabase (PostgreSQL + Auth + Storage)
```

El frontend nunca muta datos directamente contra Supabase con la anon key — todo pasa por acá con JWT del usuario.

## 2. Stack

- **Hono 4.12** — web framework
- **`@hono/zod-validator` + Zod 4** — validación de body/query/params
- **`@supabase/supabase-js` 2.78** — cliente Supabase
- **`jose` 6** — verificación de JWT vía JWKS
- **`dotenv`** — env vars
- **TypeScript + tsx** (dev) + **Vitest** (tests)
- Runtime: Node vía `@hono/node-server`

## 3. Variables de entorno (`.env`)

```
SUPABASE_URL=https://xclobkgmaxioifpkukul.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<secret>    # ⚠️ NUNCA commitear, NUNCA loguear
PORT=3001
FRONTEND_URL=http://localhost:3000    # Para CORS
```

## 4. Arquitectura del request

```
Cliente (Next.js)
  → Bearer <JWT> en Authorization header
  → logger middleware
  → cors middleware
  → auditMiddleware (se arma el contexto, se loguea post-respuesta)
  → app.route('/api/<modulo>', <moduloApp>)
     → authMiddleware (verifica JWT vía JWKS, inyecta user en context)
     → requirePermiso(modulo, accion) o requirePermisoOr(...)
     → zValidator('json'|'query'|'param', schema)
     → handler del endpoint
     → service correspondiente (lógica de negocio)
     → createSupabaseClient(accessToken) para operaciones respetando RLS
       O supabase (service role) solo cuando sea estrictamente necesario
  → response
  → auditMiddleware persiste audit log si status 2xx y método mutativo
```

## 5. Estructura de carpetas

```
src/
├── index.ts                    # Entry point, setup global
├── lib/
│   ├── supabase.ts             # Instancias de cliente (service + factory per-request)
│   └── utils/
│       └── dates.ts            # Helpers de semana viernes→jueves
├── middleware/
│   ├── auth.ts                 # authMiddleware
│   ├── permisos.ts             # requirePermiso, requirePermisoOr
│   └── audit.ts                # auditMiddleware
└── modules/
    └── <modulo>/
        ├── <modulo>.routes.ts  # Hono app con rutas + validación
        └── <modulo>.service.ts # Lógica de negocio
```

## 6. Convenciones críticas

### 6.1 Cada módulo es un `Hono()` montado
```ts
// en src/index.ts
import solicitudes from './modules/solicitudes/solicitudes.routes';
app.route('/api/solicitudes', solicitudes);
```

### 6.2 Auth + permisos al inicio del módulo
```ts
const app = new Hono();
app.use('*', authMiddleware);

app.post('/:id/comprar',
  requirePermiso('certificaciones', 'creacion'),
  zValidator('json', comprarSchema),
  async (c) => { ... }
);
```

### 6.3 Dos instancias de Supabase — elegir bien
- `supabase` (service role, importado de `lib/supabase.ts`) → úsalo solo cuando:
  - La operación NO necesita validar contra el usuario (config interna, crons, operaciones masivas).
  - La operación requiere bypassear RLS intencionalmente.
- `createSupabaseClient(accessToken)` → **por defecto**, para cualquier operación iniciada por un usuario.

### 6.4 Validación con Zod siempre
Cada endpoint mutativo valida entrada con `zValidator`. No aceptar `any` en el body.

### 6.5 Auditoría es automática
`auditMiddleware` corre **después** de la respuesta. Solo loguea:
- Métodos POST / PATCH / PUT / DELETE.
- Status 2xx.

Extrae entidad y acción de la URL. Tiene un mapping explícito para verbos: `comprar`, `despachar`, `enviar`, `archivar`, `desarchivar`, `mover`.

**NO escribir auditoría manual en handlers.** Si necesitás más detalle en el audit log, agregalo al mapping del middleware, no al handler.

### 6.6 Servicios encapsulan lógica
Los handlers en `routes.ts` son finos: extraer inputs → llamar al service → devolver respuesta. La lógica vive en `service.ts`.

### 6.7 Errores útiles para el frontend
```ts
return c.json({ error: 'STOCK_INSUFICIENTE', message: 'No hay suficiente stock...', detalle: {...} }, 400);
```
Códigos de error como constantes, mensajes en español para el usuario, `detalle` opcional con datos estructurados.

## 7. Reglas de negocio críticas (ver también CLAUDE.md del frontend)

### 7.1 RLS permisiva por diseño
Todas las ~68 tablas tienen RLS con `using(true) with check(true)`. La seguridad real está en este backend. No proponer migrar a RLS estricta sin coordinar — rompería el modelo.

### 7.2 Resolución de items (certificaciones)
- Un `solicitud_compra_item` se resuelve por **compra externa** (`origen='compra'`, estado final `comprado`) o **despacho de depósito** (estado final `de_deposito`).
- Ambos caminos deben insertar en `materiales_a_cuenta_cliente`, **EXCEPTO** cuando la obra de destino es depósito interno (`obra.es_deposito = true`) — ahí es reposición, no facturable.
- En `materiales_a_cuenta_cliente`, el campo `origen` usa `'proveedor'` o `'deposito'` (NO `'compra'`).
- ⚠️ **Deuda técnica conocida**: esta operación hoy hace múltiples llamadas a Supabase en secuencia, no transaccionalmente. Migrar a RPC de PostgreSQL (ver §9).

### 7.3 Semana viernes→jueves
CADINC cierra semanas los jueves. Todo `sem_key` es el ISO del **viernes** de esa semana. Usar helpers de `src/lib/utils/dates.ts`: `getViernes`, `getSemDays`, `toISO`. **Nunca calcular semanas con lunes-domingo.**

### 7.4 Permisos — particularidad de `personal`
`personal` no es módulo asignable en permisos — es un tab de `tarja`. Los endpoints de `/api/personal/*` usan:
```ts
requirePermisoOr('personal', 'tarja')
```

### 7.5 Auto-archivo de obras
Endpoint `POST /api/obras/auto-archivar` se dispara desde el frontend cada 6h. Archiva obras sin horas cargadas en las últimas 3 semanas.

## 8. Datos sensibles

No loguear estos valores nunca (ni en console, ni en errores, ni en audit):
- `SUPABASE_SERVICE_ROLE_KEY` y cualquier JWT
- Contraseñas (si alguna vez aparecen en endpoints de reset)
- DNI completos de empleados
- Precios de compra y datos de proveedores en logs públicos

Audit middleware ya omite claves sensibles y strings largos (URLs). Si agregás nuevos campos sensibles, actualizar el mapping de omisiones.

## 9. Deuda técnica conocida

- **Resolución de items NO transaccional** (§7.2). Migrar a RPCs `resolver_item_compra` y `resolver_item_despacho` con `SECURITY DEFINER` + `SELECT FOR UPDATE` sobre `stock_materiales` para evitar races. Plan de rollout con feature flag `USE_RPC_RESOLVER`.
- **Modelos paralelos en schema**: `empresas` vs `empresas_transportistas`, `viajes/cargas/descargas` vs `tramos`, múltiples sistemas de remitos. Consolidar caso por caso.
- **Columnas duplicadas**: `camiones.año` y `camiones.anio`.
- **Vulnerabilidades npm** (2 moderate, 1 high al clonar). Evaluar con `npm audit` y atacar con contexto — no correr `npm audit fix` a ciegas.

## 10. Qué NO hacer

- ❌ Mutar datos sin pasar por `requirePermiso[Or]`.
- ❌ Usar `supabase` (service role) cuando `createSupabaseClient(accessToken)` alcanza — rompe la trazabilidad de auditoría.
- ❌ Loguear el JWT, la service key, o datos sensibles en console.
- ❌ Escribir auditoría manual en handlers.
- ❌ Hacer múltiples mutaciones en Supabase sin transacción cuando afectan tablas relacionadas — usar RPC.
- ❌ Aceptar `any` en el body de un endpoint. Siempre validar con Zod.
- ❌ Proponer RLS estricta sin un plan completo.
- ❌ Calcular semanas con lunes-domingo.
- ❌ Crear endpoints `/api/personal/*` sin `requirePermisoOr('personal', 'tarja')`.

## 11. Comandos útiles

```bash
npm run dev        # tsx watch, levanta en puerto 3001
npm run build      # tsc
npm test           # vitest

# Inspección rápida de env vars esperadas:
grep -r "process.env" src | grep -oE "process\.env\.[A-Z_]+" | sort -u
```

Dashboard Supabase: https://supabase.com/dashboard/project/xclobkgmaxioifpkukul

## 12. Subagentes disponibles

Los subagentes viven en `.claude/agents/` del repo del frontend (`/Users/francoleiro/frontend_cadinc_gestion/.claude/agents/`). Si abrís Claude Code desde este repo del backend y querés usar los mismos subagentes, o bien:
1. Abrís Claude Code desde el frontend y pedís al subagente que lea archivos del backend con ruta absoluta, o
2. Copiás los `.md` de agentes a `.claude/agents/` de este repo también (mantener ambos sincronizados).

Los subagentes disponibles:
- `backend-specialist` — APIs Hono, services, middlewares (este repo es su casa).
- `database-architect` — schema, migraciones, RPCs.
- `security-specialist` — auth, permisos, RLS.
- `frontend-specialist` — UI/UX (trabaja en el otro repo).
- `nextjs-react-specialist` — gotchas de Next.js 16 / React 19.
- `code-reviewer` — review transversal antes de commit.

---

_Última actualización: 2026-04-22_
