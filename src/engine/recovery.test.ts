import { describe, expect, it } from 'vitest'
import { generateRecoveryCandidates, searchRecoveryOptions } from './recovery'
import { simulateSimulation } from './simulation'
import { makeTestDataset } from './test-fixtures'
import type { RecoveryPairEvaluation } from './recovery'

describe('recovery actions and search', () => {
  it('evaluates cancellation, spare, hold, crew relief, and swap options', () => {
    const dataset = makeTestDataset()
    const input = {
      dataset,
      closures: [
        { id: 'C1', airportId: 'BBB', start: 110, end: 140, label: 'Arrival closure' },
      ],
    }
    const result = generateRecoveryCandidates(input)

    expect(result.baseline.flightById.F1.status).toBe('DELAYED')
    const types = new Set(result.candidates.map((candidate) => candidate.action.type))
    expect(types.has('CANCEL_FLIGHT')).toBe(true)
    expect(types.has('ACTIVATE_SPARE')).toBe(true)
    expect(types.has('HOLD_FLIGHT')).toBe(true)
    expect(types.has('SWAP_AIRCRAFT')).toBe(true)
    expect(result.candidates.every((candidate) => candidate.valid)).toBe(true)
    expect(result.candidates.map((candidate) => candidate.rank)).toEqual(
      result.candidates.map((_, index) => index + 1),
    )
  })

  it('reports wrong-base and unavailable spare options with reasons', () => {
    const dataset = makeTestDataset()
    dataset.spares[0].availableFrom = 120
    const result = searchRecoveryOptions({
      dataset,
      closures: [
        { id: 'C1', airportId: 'BBB', start: 110, end: 140 },
      ],
    })

    expect(result.unavailableOptions.some((option) =>
      option.action.type === 'ACTIVATE_SPARE'
      && option.action.spareId === 'SP1'
      && option.reason.includes('unavailable'),
    )).toBe(true)
    expect(result.unavailableOptions.some((option) =>
      option.action.type === 'ACTIVATE_SPARE'
      && option.action.spareId === 'SP2'
      && option.reason.includes('base'),
    )).toBe(true)
  })

  it('applies cancellation, hold, spare, and swap actions deterministically', () => {
    const dataset = makeTestDataset()
    const closure = { id: 'C1', airportId: 'BBB', start: 110, end: 140 }

    const cancelled = simulateSimulation({
      dataset,
      closures: [closure],
      actions: [{ id: 'X1', type: 'CANCEL_FLIGHT', flightId: 'F1', cost: 1 }],
    })
    expect(cancelled.flightById.F1.status).toBe('CANCELLED')
    expect(cancelled.flightById.F2.status).toBe('CANCELLED')
    expect(cancelled.flightById.F2.causeChain[0].sourceFlightId).toBe('F1')

    const held = simulateSimulation({
      dataset,
      closures: [closure],
      actions: [{ id: 'X2', type: 'HOLD_FLIGHT', flightId: 'F2', holdMinutes: 15, cost: 1 }],
    })
    expect(held.flightById.F2.actualDeparture).toBe(185)
    expect(held.connections[0].status).toBe('MADE')
    expect(held.flightById.F2.causeChain.some((link) => link.code === 'RECOVERY_HOLD')).toBe(true)

    const spare = simulateSimulation({
      dataset,
      closures: [closure],
      actions: [{
        id: 'X3',
        type: 'ACTIVATE_SPARE',
        spareId: 'SP1',
        rotationTailId: 'T1',
        cost: 1,
      }],
    })
    expect(spare.flightById.F1.tailId).toBe('SP1')
    expect(spare.flightById.F2.tailId).toBe('SP1')
    expect(spare.actionValidation[0].valid).toBe(true)

    const swapped = simulateSimulation({
      dataset,
      closures: [closure],
      actions: [{
        id: 'X4',
        type: 'SWAP_AIRCRAFT',
        tailIdA: 'T1',
        tailIdB: 'T2',
        cost: 1,
      }],
    })
    expect(swapped.flightById.F1.tailId).toBe('T2')
    expect(swapped.flightById.F2.tailId).toBe('T2')
    expect(swapped.flightById.F3.tailId).toBe('T1')
  })

  it('reassigns one flight to a relief crew while the original crew skips it', () => {
    const dataset = makeTestDataset()
    dataset.crews = [
      {
        id: 'CR1',
        tailId: 'T1',
        base: 'AAA',
        dutyStart: 0,
        maxDutyMinutes: 100,
        flightIds: ['F1'],
      },
      {
        id: 'CR2',
        tailId: 'T2',
        base: 'AAA',
        dutyStart: 0,
        maxDutyMinutes: 300,
        flightIds: ['F3'],
      },
      {
        id: 'CR3',
        tailId: 'T1',
        base: 'AAA',
        dutyStart: 0,
        maxDutyMinutes: 300,
        flightIds: ['F2'],
      },
    ]
    const output = simulateSimulation({
      dataset,
      closures: [],
      actions: [{
        id: 'X1',
        type: 'REASSIGN_CREW',
        crewId: 'CR3',
        flightId: 'F1',
        cost: 1,
      }],
    })

    expect(output.actionValidation[0].valid).toBe(true)
    expect(output.flightById.F1.status).toBe('ON_TIME')
    expect(output.flightById.F1.crewId).toBe('CR3')
    expect(output.flightById.F2.status).toBe('ON_TIME')
    expect(output.crews.find((crew) => crew.id === 'CR1')?.assignedFlightIds).toEqual([])
    expect(output.crews.find((crew) => crew.id === 'CR3')?.assignedFlightIds).toEqual(['F1', 'F2'])
    expect(output.kpis.crewViolations).toBe(0)
  })

  it('returns exact KPI deltas, transparent scores, and ranked top pairs', () => {
    const dataset = makeTestDataset()
    const result = searchRecoveryOptions({
      dataset,
      closures: [
        { id: 'C1', airportId: 'BBB', start: 110, end: 140 },
      ],
    }, {
      delayMinute: 2,
      cancellation: 900,
      strandedPassenger: 20,
      crewViolation: 700,
      actionCost: 3,
    })

    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect(candidate.delta.totalDelayMinutes).toBe(
        candidate.after.totalDelayMinutes - candidate.before.totalDelayMinutes,
      )
      expect(candidate.delta.cancellations).toBe(
        candidate.after.cancelledFlights - candidate.before.cancelledFlights,
      )
      expect(candidate.delta.strandedPassengers).toBe(
        candidate.after.strandedPassengers - candidate.before.strandedPassengers,
      )
      expect(candidate.delta.crewViolations).toBe(
        candidate.after.crewViolations - candidate.before.crewViolations,
      )
      expect(candidate.rationale.join(' ')).toContain('Weighted objective')
    }
    expect(result.pairs.length).toBeGreaterThan(0)
    expect(result.pairs.map((pair) => pair.rank)).toEqual(
      result.pairs.map((_, index) => index + 1),
    )
    const firstPair = result.pairs[0] as RecoveryPairEvaluation
    expect(firstPair.pairedActions).toHaveLength(2)
  })
})
