Crea un nuevo módulo completo en el backend siguiendo la arquitectura del proyecto.

El nombre del módulo es: $ARGUMENTS

## Pasos a seguir

1. Crear la carpeta `src/modules/$ARGUMENTS/`

2. Crear `src/modules/$ARGUMENTS/$ARGUMENTS.schema.ts` usando la plantilla del CLAUDE.md. Inferir los campos del dominio basándote en el nombre del módulo.

3. Crear `src/modules/$ARGUMENTS/$ARGUMENTS.service.ts` con los métodos CRUD usando la plantilla del CLAUDE.md.

4. Crear `src/modules/$ARGUMENTS/$ARGUMENTS.routes.ts` con todas las rutas usando la plantilla del CLAUDE.md. Usar el nombre del módulo como nombre del permiso.

5. Agregar el import y el `app.route()` en `src/index.ts`.

6. Confirmar al usuario qué tabla de Supabase asume y qué campos creó. Preguntarle si ajustar algo antes de terminar.
