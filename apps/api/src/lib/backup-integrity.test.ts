import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { verifyBackupIntegrity, resolveStorageObjectPath, type BackupManifest } from './backup-integrity'

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function manifestFor(files: Array<{ path: string; content: string }>): BackupManifest {
  return {
    instanceId: 'test-instance',
    commit: 'abc123',
    date: new Date().toISOString(),
    migrations: [{ filename: '0001_initial.sql', applied_at: new Date().toISOString() }],
    account: { email: 'test@example.test', password: 'secret' },
    contact: { id: '00000000-0000-0000-0000-000000000001', whatsapp_number: '+525550000001', name: 'Test', country: 'MX' },
    conversation: { id: '00000000-0000-0000-0000-000000000002', body: 'hola' },
    message: { id: '00000000-0000-0000-0000-000000000003' },
    attachment: { path: 'muestra/file.txt' },
    files: files.map((f) => ({
      path: f.path,
      size: Buffer.byteLength(f.content),
      sha256: sha256(f.content),
    })),
  }
}

describe('verifyBackupIntegrity', () => {
  let backupDir: string

  beforeEach(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'backup-integrity-'))
  })

  afterEach(() => {
    rmSync(backupDir, { recursive: true, force: true })
  })

  it('pasa cuando todos los archivos existen y los hashes coinciden', () => {
    const files = [
      { path: 'public.sql', content: 'create table test (id int);' },
      { path: 'storage/muestra/file.txt', content: 'contenido de muestra' },
    ]
    for (const f of files) {
      const full = join(backupDir, f.path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, f.content)
    }

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(true)
  })

  it('falla cuando falta un archivo del respaldo', () => {
    const files = [{ path: 'public.sql', content: 'create table test (id int);' }]
    // no escribimos nada: el archivo falta

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('public.sql')
      expect(result.error.toLowerCase()).toContain('falta')
    }
  })

  it('falla cuando el hash de un archivo no coincide y reporta esperado/actual', () => {
    const files = [{ path: 'public.sql', content: 'create table test (id int);' }]
    const full = join(backupDir, files[0].path)
    // Mismo tamaño, bytes distintos: fuerza el fallo en el hash, no en el tamaño.
    const corrupted = 'create table fake (id int);'
    writeFileSync(full, corrupted)
    const expected = sha256(files[0].content)
    const actual = sha256(corrupted)

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('public.sql')
      expect(result.error).toContain(expected)
      expect(result.error).toContain(actual)
    }
  })

  it('falla cuando el tamaño no coincide y reporta esperado/actual', () => {
    const files = [{ path: 'public.sql', content: 'create table test (id int);' }]
    writeFileSync(join(backupDir, files[0].path), 'create table test (id int); -- mas bytes')

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('public.sql')
      expect(result.error).toContain('Tamaño no coincide')
      expect(result.error).toContain(String(files[0].content.length))
      expect(result.error).toContain(String(files[0].content.length + 13))
    }
  })

  it('falla nombrando el hash cuando el archivo cambió de tamaño y de contenido', () => {
    const files = [{ path: 'public.sql', content: 'create table test (id int);' }]
    writeFileSync(join(backupDir, files[0].path), 'create table test (id int); -- mas bytes')

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Hash sha256 no coincide')
      expect(result.error).toContain(sha256(files[0].content))
      expect(result.error).toContain(sha256('create table test (id int); -- mas bytes'))
    }
  })

  it('falla cuando el manifiesto no declara ningún archivo', () => {
    const result = verifyBackupIntegrity(backupDir, manifestFor([]))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('ningún archivo')
    }
  })

  it('falla con un mensaje estructurado cuando el manifiesto no tiene el arreglo de archivos', () => {
    const manifest = { ...manifestFor([]) } as unknown as BackupManifest
    delete (manifest as { files?: unknown }).files

    const result = verifyBackupIntegrity(backupDir, manifest)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('archivo')
    }
  })

  it('falla con un mensaje estructurado cuando la entrada apunta a un directorio', () => {
    const files = [{ path: 'public.sql', content: 'create table test (id int);' }]
    mkdirSync(join(backupDir, 'public.sql'), { recursive: true })

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('public.sql')
      expect(result.error).toContain('no es un archivo')
    }
  })

  it('falla cuando hay un archivo en storage/ que el manifiesto no declara', () => {
    const files = [
      { path: 'public.sql', content: 'create table test (id int);' },
      { path: 'storage/muestra/file.txt', content: 'contenido de muestra' },
    ]
    for (const f of files) {
      const full = join(backupDir, f.path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, f.content)
    }
    // Un objeto de más, que nadie verificó: no se restaura en silencio.
    const extra = join(backupDir, 'storage/muestra/colado.txt')
    mkdirSync(join(extra, '..'), { recursive: true })
    writeFileSync(extra, 'no declarado')

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('storage/muestra/colado.txt')
      expect(result.error).toContain('no declara')
    }
  })

  it('no acepta una ruta que se sale del directorio del respaldo', () => {
    const files = [{ path: '../fuera.txt', content: 'secreto' }]
    writeFileSync(join(backupDir, '..', 'fuera.txt'), 'secreto')

    const result = verifyBackupIntegrity(backupDir, manifestFor(files))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('se sale del directorio')
    }
  })
})

describe('resolveStorageObjectPath', () => {
  const storageDir = '/tmp/ejemplo-respaldo/storage'

  it('acepta un nombre de objeto normal y lo deja dentro del directorio', () => {
    const ruta = resolveStorageObjectPath(storageDir, 'muestra/evidencia.txt')

    expect(ruta).not.toBeNull()
    expect(ruta?.startsWith(storageDir)).toBe(true)
  })

  it('rechaza un nombre con segmentos de directorio padre', () => {
    expect(resolveStorageObjectPath(storageDir, '../fuera.txt')).toBeNull()
    expect(resolveStorageObjectPath(storageDir, 'muestra/../../fuera.txt')).toBeNull()
  })

  it('rechaza una ruta absoluta y un nombre vacío', () => {
    expect(resolveStorageObjectPath(storageDir, '/etc/passwd')).toBeNull()
    expect(resolveStorageObjectPath(storageDir, '')).toBeNull()
    expect(resolveStorageObjectPath(storageDir, 'a//b.txt')).toBeNull()
  })
})

/**
 * El manifiesto es el contrato entre quien crea el respaldo y quien lo
 * restaura. Aquí se construye como lo hace `create-backup.ts` y se comprueba
 * que el consumidor (el ensayo) lo puede leer sin sorpresas.
 */describe('el manifiesto que escribe el creador', () => {
  let backupDir: string

  beforeEach(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'backup-manifest-'))
  })

  afterEach(() => {
    rmSync(backupDir, { recursive: true, force: true })
  })

  it('lo construye con tamaño y hash por archivo y el consumidor lo acepta', () => {
    const dump = 'create table test (id int);\n'
    const attachment = 'contenido de muestra\n'
    const attachmentPath = 'muestra/backup-rehearsal.txt'

    for (const [path, content] of [
      ['public.sql', dump],
      [`storage/${attachmentPath}`, attachment],
    ] as const) {
      const full = join(backupDir, path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }

    // La forma del manifiesto, tal como la arma el creador.
    const manifest: BackupManifest = {
      instanceId: 'onano-support-dev',
      commit: 'abc123',
      date: new Date().toISOString(),
      migrations: [{ filename: '0001_initial.sql', applied_at: new Date().toISOString() }],
      account: { email: 'muestra@example.test', password: 'clave-generada' },
      contact: {
        id: '00000000-0000-0000-0000-000000000001',
        whatsapp_number: '+525550000001',
        name: 'Test',
        country: 'MX',
      },
      conversation: { id: '00000000-0000-0000-0000-000000000002', body: 'hola' },
      message: { id: '00000000-0000-0000-0000-000000000003' },
      attachment: { path: attachmentPath },
      files: [
        { path: 'public.sql', size: Buffer.byteLength(dump), sha256: sha256(dump) },
        {
          path: `storage/${attachmentPath}`,
          size: Buffer.byteLength(attachment),
          sha256: sha256(attachment),
          contentType: 'text/plain',
        },
      ],
      extensions: ['pg_trgm'],
      tableCounts: [{ table: 'contacts', rows: 1 }],
    }

    // Cada entrada trae las tres cosas que el consumidor necesita.
    for (const entry of manifest.files) {
      expect(typeof entry.path).toBe('string')
      expect(typeof entry.size).toBe('number')
      expect(typeof entry.sha256).toBe('string')
      expect(entry.sha256).toHaveLength(64)
    }

    // El volcado está declarado.
    expect(manifest.files.map((f) => f.path)).toContain('public.sql')

    // El adjunto que el ensayo busca tiene entrada propia.
    const attachmentEntry = manifest.files.find((f) => f.path === `storage/${manifest.attachment.path}`)
    expect(attachmentEntry).toBeDefined()

    // Y el consumidor lo acepta sin quejarse.
    const result = verifyBackupIntegrity(backupDir, manifest)
    expect(result.ok).toBe(true)
  })
})
