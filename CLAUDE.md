# Backend — cadincsrl

## Contexto del sistema

**CADINC SRL** es una empresa constructora argentina. Este backend es la API de su sistema de gestión interna.

**Módulos del negocio:**
- **Tarja**: control diario de horas de operarios en obras de construcción. El flujo central: operarios → horas por día → cierre semanal → cálculo de pago (horas × tarifa)
- **Cierres**: bloqueo semanal por obra. `sem_key` = viernes de la semana (YYYY-MM-DD). El viernes siguiente es el día de cobro
- **Contratistas**: empresas externas. Se certifican por monto fijo semanal (distinto a operarios que cobran por hora)
- **Herramientas**: inventario de equipos con trazabilidad de movimientos entre obras
- **Logística**: viajes de camiones entre canteras (origen) y depósitos (destino). Los choferes se liquidan por km + básico diario - adelantos
- **Personal**: legajos de operarios. El `leg` (legajo) es el ID único del operario

**Referencia de negocio**: el archivo `index.html` en la raíz del proyecto es el sistema viejo — contiene toda la lógica de negocio como referencia cuando hay dudas.

API REST construida con **Hono + Node.js + TypeScript**. Base de datos en **Supabase (PostgreSQL)** con autenticación JWT vía Jose.

## Comandos

```bash
npm run dev          # desarrollo con hot-reload (tsx watch)
npm run build        # compilar TypeScript → dist/
npm run start        # producción
npm run test         # Vitest
npm run lint         # ESLint
npm run typecheck    # TypeScript sin emitir (chequeo rápido)
npm run format       # Prettier
```

## Estructura de un módulo

Cada módulo vive en `src/modules/[nombre]/` con exactamente tres archivos:

```
[nombre].schema.ts   → tipos Zod + DTOs
[nombre].service.ts  → lógica de negocio + llamadas a Supabase
[nombre].routes.ts   → router Hono + middleware
```

Registrar en `src/index.ts`:
```typescript
import [nombre]Routes from './modules/[nombre]/[nombre].routes.js'
app.route('/api/[nombre]', [nombre]Routes)
```

---

## Plantillas exactas

### schema.ts
```typescript
import { z } from 'zod'

export const [Entidad]Schema = z.object({
  id:  z.number(),
  nom: z.string(),
  // ...
})

export const Create[Entidad]Schema = z.object({
  nom: z.string().min(1),
  // campos requeridos sin id
})

export const Update[Entidad]Schema = z.object({
  nom: z.string().min(1).optional(),
  // todos opcionales
})

export type [Entidad]    = z.infer<typeof [Entidad]Schema>
export type Create[Entidad]Dto = z.infer<typeof Create[Entidad]Schema>
export type Update[Entidad]Dto = z.infer<typeof Update[Entidad]Schema>
```

### service.ts
```typescript
import { createSupabaseClient } from '../../lib/supabase.js'
import type { Create[Entidad]Dto, Update[Entidad]Dto } from './[nombre].schema.js'

export const [nombre]Service = {
  async getAll(token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('[tabla]').select('*').order('nom')
    if (error) throw new Error(error.message)
    return data
  },

  async getById(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase.from('[tabla]').select('*').eq('id', id).single()
    if (error) throw new Error(error.message)
    return data
  },

  async create(dto: Create[Entidad]Dto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('[tabla]')
      .insert({ ...dto, created_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update(id: number, dto: Update[Entidad]Dto, token: string, userId: string) {
    const supabase = createSupabaseClient(token)
    const { data, error } = await supabase
      .from('[tabla]')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async delete(id: number, token: string) {
    const supabase = createSupabaseClient(token)
    const { error } = await supabase.from('[tabla]').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
}
```

### routes.ts
```typescript
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermiso } from '../../middleware/permission.js'
import { [nombre]Service } from './[nombre].service.js'
import { Create[Entidad]Schema, Update[Entidad]Schema } from './[nombre].schema.js'

const [nombre] = new Hono()

[nombre].use('*', authMiddleware)

[nombre].get('/', requirePermiso('[modulo]', 'lectura'), async (c) => {
  const token = c.get('accessToken')
  const data = await [nombre]Service.getAll(token)
  return c.json(data)
})

[nombre].get('/:id', requirePermiso('[modulo]', 'lectura'), async (c) => {
  const id = Number(c.req.param('id'))
  const token = c.get('accessToken')
  const data = await [nombre]Service.getById(id, token)
  return c.json(data)
})

[nombre].post('/', requirePermiso('[modulo]', 'creacion'), zValidator('json', Create[Entidad]Schema), async (c) => {
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await [nombre]Service.create(dto, token, userId)
  return c.json(data, 201)
})

[nombre].patch('/:id', requirePermiso('[modulo]', 'actualizacion'), zValidator('json', Update[Entidad]Schema), async (c) => {
  const id = Number(c.req.param('id'))
  const dto = c.req.valid('json')
  const token = c.get('accessToken')
  const userId = c.get('user').id
  const data = await [nombre]Service.update(id, dto, token, userId)
  return c.json(data)
})

[nombre].delete('/:id', requirePermiso('[modulo]', 'eliminacion'), async (c) => {
  const id = Number(c.req.param('id'))
  const token = c.get('accessToken')
  await [nombre]Service.delete(id, token)
  return c.json({ success: true })
})

export default [nombre]
```

---

## Reglas importantes

- **Siempre usar `createSupabaseClient(token)`** en los servicios, nunca el cliente admin `supabase`
- El cliente admin solo se usa en middleware (`permission.ts`) o endpoints `/all` que requieren bypassear RLS
- Los accesos en `c.get('accessToken')` y `c.get('user')` solo funcionan después de `authMiddleware`
- Los permisos son `'lectura' | 'creacion' | 'actualizacion' | 'eliminacion'`
- Los servicios siempre lanzan `throw new Error(error.message)` en lugar de devolver el error
- Usar `import type` para importar solo tipos

## Variables de entorno

Ver `.env.example`. Las obligatorias: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FRONTEND_URL`.
