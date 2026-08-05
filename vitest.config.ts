// Los tests no usan variables de entorno; apuntar envDir a un directorio sin
// .env evita que Vite intente leer el .env de la raíz — acá es un symlink a
// ~/Documents (fuera del repo) y según los permisos de macOS del shell esa
// lectura puede tirar EPERM y voltear la suite entera al arrancar. En Render
// no hay .env (ENOENT se ignora), así que esto no cambia nada del gate.
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  envDir: path.resolve(__dirname, 'tests'),
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
