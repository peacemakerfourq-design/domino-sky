import { describe, expect, it } from 'vitest'
import {
  generateTemplateNarrative,
  injectWrongNumber,
  validateNarrative,
} from './validator'

const enginePayload = {
  baseline: {
    kpis: {
      totalDelayMinutes: 90,
      strandedPassengers: 20,
      cancelledFlights: 2,
      crewViolations: 1,
    },
    closures: [{ airportId: 'BOM', start: 840, end: 930 }],
    flightIds: ['DS0101'],
  },
  candidates: [
    {
      action: { id: 'CANCEL-DS0101', type: 'CANCEL_FLIGHT' },
      after: { kpis: { totalDelayMinutes: 75, strandedPassengers: 12 } },
    },
  ],
  pairs: [],
}

describe('Number Guard validator', () => {
  it('accepts numeric claims that exist in engine output', () => {
    const report = validateNarrative(
      'The engine found 90 delay minutes and 20 stranded passengers.',
      enginePayload,
    )

    expect(report.valid).toBe(true)
    expect(report.verifiedCount).toBe(2)
    expect(report.totalCount).toBe(2)
    expect(report.sentences[0].claims[0].source).toContain('baseline')
  })

  it('blocks only the sentence containing an unsupported number', () => {
    const report = validateNarrative(
      'The delay is 90 minutes. The stranded count is 999 passengers.',
      enginePayload,
    )

    expect(report.valid).toBe(false)
    expect(report.sentences[0].valid).toBe(true)
    expect(report.sentences[1].valid).toBe(false)
    expect(report.verifiedCount).toBe(1)
    expect(report.totalCount).toBe(2)
  })

  it('verifies HH:MM claims against minute values', () => {
    const report = validateNarrative('BOM closes at 14:00.', enginePayload)

    expect(report.valid).toBe(true)
    expect(report.sentences[0].claims[0].kind).toBe('time')
    expect(report.sentences[0].claims[0].value).toBe(840)
  })

  it('verifies flight identifiers against dataset identifiers', () => {
    const report = validateNarrative('Flight DS0101 is affected.', enginePayload)

    expect(report.valid).toBe(true)
    expect(report.sentences[0].claims[0].kind).toBe('identifier')
    expect(report.sentences[0].claims[0].value).toBe(101)
  })

  it('verifies percentages when the engine contains the numeric value', () => {
    const report = validateNarrative('The impact is 50% of the baseline.', {
      ...enginePayload,
      ratio: 50,
    })

    expect(report.valid).toBe(true)
    expect(report.sentences[0].claims[0].kind).toBe('percentage')
  })

  it('injects a deterministic wrong number for the tamper test', () => {
    const tampered = injectWrongNumber('There are 90 delayed minutes.')
    const report = validateNarrative(tampered, enginePayload)

    expect(tampered).toContain('91')
    expect(report.valid).toBe(false)
    expect(report.sentences[0].valid).toBe(false)
  })

  it('generates a code-only fallback from engine facts', () => {
    const fallback = generateTemplateNarrative(enginePayload)
    const report = validateNarrative(fallback, enginePayload)

    expect(fallback).toContain('90')
    expect(fallback).toContain('75')
    expect(report.valid).toBe(true)
  })
})
