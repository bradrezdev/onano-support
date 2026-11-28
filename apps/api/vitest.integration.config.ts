import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Suite de integración contra una instancia real (base efímera de Supabase en
 * CI). Va aparte de la suite unitaria a propósito: estas pruebas necesitan
 * una base, una API viva y credenciales sintéticas, y no deben contar como
 * "pruebas ejecutadas" cuando el entorno no las tiene.
 *
 *   pnpm --filter @crm/api test:integration
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
