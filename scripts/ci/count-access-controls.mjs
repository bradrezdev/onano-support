#!/usr/bin/env node
/**
 * Puerta de los controles de autorización: comprueba que la suite de
 * aceptación REALMENTE se ejecutó.
 *
 * Un control que no se ejecuta no es un control que pasa: es un control
 * PENDIENTE. Este script lee el reporte JSON de vitest y falla si:
 *   · la suite de conversaciones/adjuntos no aparece,
 *   · alguno de sus casos fue omitido (skipped) o quedó pendiente,
 *   · se ejecutaron menos casos de los obligatorios.
 *
 *   node scripts/ci/count-access-controls.mjs <reporte.json> [mínimo]
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const MINIMUM = Number(process.argv[3] ?? 32)
const SUITE = 'integration/conversation-authorization.test.ts'

if (!file) {
  console.error('uso: node scripts/ci/count-access-controls.mjs <reporte.json> [mínimo]')
  process.exit(2)
}

let report
try {
  report = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`FALLO: no se pudo leer el reporte de controles (${file}): ${e.message}`)
  console.error('Sin reporte no hay prueba de que los controles se ejecutaron: el job falla.')
  process.exit(1)
}

const files = report.testResults ?? []
const suite = files.find((f) => (f.name ?? '').endsWith(SUITE))

if (!suite) {
  console.error(`FALLO: la suite de controles ${SUITE} NO aparece en el reporte.`)
  console.error('Ejecutadas: ' + (files.map((f) => f.name).join(', ') || 'ninguna'))
  process.exit(1)
}

const assertions = suite.assertionResults ?? []
const passed = assertions.filter((a) => a.status === 'passed')
const skipped = assertions.filter((a) => a.status === 'pending' || a.status === 'skipped')
const failed = assertions.filter((a) => a.status === 'failed')

console.log(`Suite: ${SUITE}`)
console.log(`  casos ejecutados: ${passed.length}`)
console.log(`  omitidos: ${skipped.length}`)
console.log(`  fallidos: ${failed.length}`)

if (skipped.length > 0) {
  console.error('')
  console.error(`FALLO: ${skipped.length} caso(s) OMITIDO(S). Un caso omitido es un control PENDIENTE.`)
  for (const s of skipped) console.error(`  · ${s.fullName ?? s.title}`)
  process.exit(1)
}

if (failed.length > 0) {
  console.error('')
  console.error(`FALLO: ${failed.length} control(es) en rojo.`)
  for (const f of failed) console.error(`  · ${f.fullName ?? f.title}`)
  process.exit(1)
}

if (passed.length < MINIMUM) {
  console.error('')
  console.error(`FALLO: se ejecutaron ${passed.length} controles y son obligatorios ${MINIMUM}.`)
  process.exit(1)
}

console.log(`OK · ${passed.length} controles de autorización ejecutados y en verde.`)
