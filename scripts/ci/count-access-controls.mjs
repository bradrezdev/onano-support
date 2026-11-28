#!/usr/bin/env node
/**
 * Puerta de los controles de aceptación: comprueba que las suites
 * REALMENTE se ejecutaron.
 *
 * Un control que no se ejecuta no es un control que pasa: es un control
 * PENDIENTE. Este script lee el reporte JSON de vitest y falla si:
 *   · alguna de las suites obligatorias no aparece,
 *   · alguno de sus casos fue omitido (skipped) o quedó pendiente,
 *   · se ejecutaron menos casos de los obligatorios.
 *
 *   node scripts/ci/count-access-controls.mjs <reporte.json> [mínimo] [mínimo_recepción]
 *
 * Las suites obligatorias:
 *   · integration/conversation-authorization.test.ts — autorización de
 *     conversaciones y adjuntos (PR #2).
 *   · integration/whatsapp-inbound.test.ts — recepción de WhatsApp (E3):
 *     entregas simultáneas, cliente nuevo, hilo cerrado y caída con reintento.
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const MINIMUM = Number(process.argv[3] ?? 32)
const INBOUND_MINIMUM = Number(process.argv[4] ?? 7)

const SUITES = [
  {
    file: 'integration/conversation-authorization.test.ts',
    minimum: MINIMUM,
    label: 'autorización de conversaciones y adjuntos',
  },
  {
    file: 'integration/whatsapp-inbound.test.ts',
    minimum: INBOUND_MINIMUM,
    label: 'recepción de WhatsApp',
  },
]

if (!file) {
  console.error(
    'uso: node scripts/ci/count-access-controls.mjs <reporte.json> [mínimo] [mínimo_recepción]',
  )
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
let failed = false

for (const suite of SUITES) {
  const found = files.find((f) => (f.name ?? '').endsWith(suite.file))

  if (!found) {
    console.error(`FALLO: la suite de controles ${suite.file} NO aparece en el reporte.`)
    console.error('Ejecutadas: ' + (files.map((f) => f.name).join(', ') || 'ninguna'))
    failed = true
    continue
  }

  const assertions = found.assertionResults ?? []
  const passed = assertions.filter((a) => a.status === 'passed')
  const skipped = assertions.filter((a) => a.status === 'pending' || a.status === 'skipped')
  const red = assertions.filter((a) => a.status === 'failed')

  console.log(`Suite: ${suite.file} (${suite.label})`)
  console.log(`  casos ejecutados: ${passed.length}`)
  console.log(`  omitidos: ${skipped.length}`)
  console.log(`  fallidos: ${red.length}`)

  if (skipped.length > 0) {
    console.error('')
    console.error(`FALLO: ${skipped.length} caso(s) OMITIDO(S). Un caso omitido es un control PENDIENTE.`)
    for (const s of skipped) console.error(`  · ${s.fullName ?? s.title}`)
    failed = true
  }

  if (red.length > 0) {
    console.error('')
    console.error(`FALLO: ${red.length} control(es) en rojo.`)
    for (const f of red) console.error(`  · ${f.fullName ?? f.title}`)
    failed = true
  }

  if (passed.length < suite.minimum) {
    console.error('')
    console.error(
      `FALLO: se ejecutaron ${passed.length} controles y son obligatorios ${suite.minimum}.`,
    )
    failed = true
  }
}

if (failed) {
  process.exit(1)
}

console.log(
  `OK · ${SUITES.map((s) => `${s.file} (${s.minimum})`).join(' + ')} controles ejecutados y en verde.`,
)
