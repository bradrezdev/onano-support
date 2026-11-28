import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface BackupFileEntry {
  path: string
  size: number
  sha256: string
}

export interface BackupManifest {
  instanceId: string
  commit: string
  date: string
  migrations: Array<{ filename: string; applied_at: string }>
  account: { email: string; password: string }
  contact: {
    id: string
    whatsapp_number: string
    name: string | null
    country: string | null
  }
  conversation: { id: string; body: string }
  message: { id: string }
  attachment: { path: string }
  files: BackupFileEntry[]
}

export type IntegrityResult = { ok: true } | { ok: false; error: string }

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Verifica que cada archivo listado en el manifiesto exista en el directorio
 * del respaldo y que su sha256 coincida con el registrado.
 *
 * Es una función pura respecto al sistema de archivos: no toca la base ni
 * Supabase; solo lee archivos locales y computa hashes.
 */
export function verifyBackupIntegrity(
  backupDir: string,
  manifest: BackupManifest,
): IntegrityResult {
  for (const entry of manifest.files) {
    const fullPath = join(backupDir, entry.path)
    if (!existsSync(fullPath)) {
      return { ok: false, error: `Falta el archivo del respaldo: ${entry.path}` }
    }

    const actual = fileSha256(fullPath)
    if (actual !== entry.sha256) {
      return {
        ok: false,
        error: `Hash sha256 no coincide para ${entry.path}: esperado ${entry.sha256}, encontrado ${actual}`,
      }
    }
  }

  return { ok: true }
}
