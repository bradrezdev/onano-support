import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, sep, isAbsolute } from 'node:path'

export interface BackupFileEntry {
  path: string
  size: number
  sha256: string
  /** Tipo MIME del objeto guardado (solo lo llevan los archivos de storage). */
  contentType?: string
}

/** Filas que tenía cada tabla del esquema volcado. */
export interface BackupTableCount {
  table: string
  rows: number
}

/**
 * Dependencia del esquema `public` hacia un objeto que vive FUERA del
 * respaldo (en Supabase, el esquema `auth` lo administra GoTrue). El volcado
 * lleva la clave foránea pero no la tabla referenciada: sin esta lista, el
 * volcado no se puede aplicar en una base limpia.
 */
export interface BackupExternalDependency {
  schema: string
  table: string
  column: string
  type: string
  fromSchema: string
  fromTable: string
  fromColumn: string
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
  /**
   * Extensiones que el esquema público necesita. `pg_dump --schema=public`
   * NO las incluye (son objetos de base, no de esquema), así que sin esta
   * lista el volcado no se puede aplicar en una base limpia.
   */
  extensions?: string[]
  /**
   * Filas por tabla del volcado. Es lo que permite comprobar que el dump
   * contiene los datos y no solo el esquema.
   */
  tableCounts?: BackupTableCount[]
  /** Objetos fuera de `public` de los que depende el esquema volcado. */
  externalDependencies?: BackupExternalDependency[]
}

export type IntegrityResult = { ok: true } | { ok: false; error: string }

const STORAGE_PREFIX = 'storage/'

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Resuelve la ruta de un archivo del respaldo y se niega a salir del
 * directorio: un manifiesto manipulado no puede leer `/etc/passwd`.
 *
 * Devuelve `null` cuando la ruta es inválida o se sale del respaldo.
 */
export function resolveBackupFilePath(backupDir: string, relativePath: unknown): string | null {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null
  if (relativePath.includes('\0')) return null
  if (isAbsolute(relativePath)) return null

  const root = resolve(backupDir)
  const full = resolve(root, relativePath)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

/**
 * Resuelve la ruta de un objeto de Storage dentro del directorio `storage/`
 * del respaldo.
 *
 * Rechaza rutas absolutas, segmentos `..` y nombres vacíos: el nombre de un
 * objeto no puede escribir fuera del directorio del respaldo.
 */
export function resolveStorageObjectPath(storageDir: string, objectName: unknown): string | null {
  if (typeof objectName !== 'string' || objectName.length === 0) return null
  if (objectName.includes('\0')) return null
  if (isAbsolute(objectName)) return null
  if (objectName.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }
  return resolveBackupFilePath(storageDir, objectName)
}

/**
 * Archivos que están bajo `storage/` pero que el manifiesto NO declara.
 *
 * Un respaldo manipulado podría traer objetos extra que la restauración
 * subiría al destino sin que nadie los haya verificado: se reportan aquí.
 */
export function findUndeclaredStorageFiles(backupDir: string, manifest: BackupManifest): string[] {
  const declared = new Set(
    (Array.isArray(manifest?.files) ? manifest.files : [])
      .map((entry) => entry?.path)
      .filter((path): path is string => typeof path === 'string' && path.startsWith(STORAGE_PREFIX)),
  )

  const storageRoot = join(backupDir, 'storage')
  if (!existsSync(storageRoot)) return []

  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const relative = `${prefix}${entry}`
      if (statSync(full).isDirectory()) {
        walk(full, `${relative}/`)
      } else {
        found.push(`${STORAGE_PREFIX}${relative}`)
      }
    }
  }
  walk(storageRoot, '')

  return found.filter((path) => !declared.has(path)).sort()
}

/**
 * Verifica que el directorio del respaldo sea EXACTAMENTE lo que el manifiesto
 * declara: cada archivo listado existe, tiene el tamaño y el sha256
 * registrados, y no hay archivos de `storage/` sin declarar.
 *
 * Es una función pura respecto al sistema de archivos: no toca la base ni
 * Supabase; solo lee archivos locales y computa hashes. Todo problema se
 * devuelve como `{ ok: false, error }`: nunca se lanza una excepción.
 */
export function verifyBackupIntegrity(
  backupDir: string,
  manifest: BackupManifest,
): IntegrityResult {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'El manifiesto no es un objeto legible' }
  }
  if (!Array.isArray(manifest.files)) {
    return { ok: false, error: 'El manifiesto no declara el arreglo de archivos' }
  }
  if (manifest.files.length === 0) {
    return {
      ok: false,
      error: 'El manifiesto no declara ningún archivo: un respaldo sin archivos no prueba nada',
    }
  }

  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      typeof entry.size !== 'number'
    ) {
      return { ok: false, error: 'El manifiesto tiene una entrada de archivo inválida' }
    }

    const fullPath = resolveBackupFilePath(backupDir, entry.path)
    if (!fullPath) {
      return {
        ok: false,
        error: `La ruta del archivo se sale del directorio del respaldo: ${entry.path}`,
      }
    }
    if (!existsSync(fullPath)) {
      return { ok: false, error: `Falta el archivo del respaldo: ${entry.path}` }
    }
    if (!statSync(fullPath).isFile()) {
      return { ok: false, error: `La entrada del manifiesto no es un archivo: ${entry.path}` }
    }

    const actualSize = statSync(fullPath).size
    const actual = fileSha256(fullPath)
    // Se reportan TODAS las diferencias del archivo: tamaño y hash. Un
    // archivo alterado suele diferir en las dos cosas y el mensaje tiene que
    // nombrar las dos.
    const diferencias: string[] = []
    if (actualSize !== entry.size) {
      diferencias.push(
        `Tamaño no coincide para ${entry.path}: esperado ${entry.size}, encontrado ${actualSize}`,
      )
    }
    if (actual !== entry.sha256) {
      diferencias.push(
        `Hash sha256 no coincide para ${entry.path}: esperado ${entry.sha256}, encontrado ${actual}`,
      )
    }
    if (diferencias.length > 0) {
      return { ok: false, error: diferencias.join('. ') }
    }
  }

  const undeclared = findUndeclaredStorageFiles(backupDir, manifest)
  if (undeclared.length > 0) {
    return {
      ok: false,
      error: `Archivo en storage/ que el manifiesto no declara: ${undeclared.join(', ')}`,
    }
  }

  return { ok: true }
}
