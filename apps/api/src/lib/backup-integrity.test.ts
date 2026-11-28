import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { verifyBackupIntegrity, type BackupManifest } from './backup-integrity'

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
})
