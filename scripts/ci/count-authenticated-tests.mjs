#!/usr/bin/env node
/**
 * Cuenta lo que Playwright REALMENTE ejecutó y falla si no corrieron pruebas
 * autenticadas (S8).
 *
 * El punto: un job verde que no ejecutó nada es peor que un job rojo. La
 * suite protegida se omite cuando faltan credenciales, así que "todo verde"
 * puede significar "cero pruebas". Este script lee el reporte JSON, publica
 * los conteos y exige el testigo de autenticación (un archivo que la suite
 * protegida escribe solo después de iniciar sesión de verdad).
 *
 *   node scripts/ci/count-authenticated-tests.mjs <reporte.json> <testigo>
 */

import { readFileSync, existsSync, readFileSync as read } from 'node:fs'

const reportPath = process.argv[2] ?? '/tmp/e2e-results.json'
const markerPath = process.argv[3] ?? '/tmp/e2e-auth-marker.txt'

if (!existsSync(reportPath)) {
  console.error(`FALLO: no existe el reporte de Playwright (${reportPath}).`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))

let total = 0
let passed = 0
let failed = 0
let skipped = 0
const perFile = new Map()

function walk(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? spec.fileName ?? suite.file ?? 'desconocido'
      for (const test of spec.tests ?? []) {
        total += 1
        const results = test.results ?? []
        const last = results[results.length - 1]
        const status = test.status ?? last?.status ?? 'unknown'
        if (status === 'passed') passed += 1
        else if (status === 'failed') failed += 1
        else if (status === 'skipped') skipped += 1
        const entry = perFile.get(file) ?? { passed: 0, failed: 0, skipped: 0, other: 0 }
        if (status === 'passed') entry.passed += 1
        else if (status === 'failed') entry.failed += 1
        else if (status === 'skipped') entry.skipped += 1
        else entry.other += 1
        perFile.set(file, entry)
      }
    }
    walk(suite.suites)
  }
}

walk(report.suites)

const authenticatedRuns = existsSync(markerPath)
  ? read(markerPath, 'utf8').split('\n').filter((l) => l.trim().length > 0).length
  : 0

console.log('Conteo de Playwright:')
console.log(`  total=${total} pasadas=${passed} fallidas=${failed} omitidas=${skipped}`)
for (const [file, counts] of perFile) {
  console.log(
    `  ${file}: ${counts.passed} pasadas, ${counts.failed} fallidas, ${counts.skipped} omitidas` +
      (counts.other ? `, ${counts.other} otro` : ''),
  )
}
console.log(`  autenticaciones reales (testigo): ${authenticatedRuns}`)

if (authenticatedRuns === 0) {
  console.error('')
  console.error('E1 · PENDIENTE: se ejecutaron CERO pruebas autenticadas.')
  console.error(
    'La suite protegida se omite sin credenciales, así que este job puede estar verde ' +
      'sin haber probado nada. Sin pruebas autenticadas no hay evidencia de quién ' +
      'puede cambiar cada campo protegido.',
  )
  process.exit(1)
}

if (failed > 0) {
  console.error(`FALLO: ${failed} prueba(s) de Playwright fallaron.`)
  process.exit(1)
}

console.log('OK · hubo pruebas autenticadas y ninguna falló.')
