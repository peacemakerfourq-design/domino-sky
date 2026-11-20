import { describe, expect, it } from 'vitest'
import { simulateSimulation } from './simulation'
import { makeTestDataset } from './test-fixtures'

describe('simulateSimulation', () => {
  it('is deterministic and preserves the baseline schedule and zero delays', () => {
    const dataset = makeTestDataset()
    const input = { dataset, closures: [] }

    const first = simulateSimulation(input)
    const second = simulateSimulation(input)

    expect(second).toEqual(first)
    expect(first.flights.map((flight) => flight.status)).toEqual(['ON_TIME', 'ON_TIME', 'ON_TIME'])
    expect(first.flights.every((flight) => flight.delayMinutes === 0)).toBe(true)
    expect(first.flights.map((flight) => flight.actualDeparture)).toEqual([60, 150, 90])
    expect(first.flights.map((flight) => flight.actualArrival)).toEqual([120, 210, 180])
  })

  it('blocks departures and arrivals, including overlapping closures', () => {
    const dataset = makeTestDataset()
    const output = simulateSimulation({
      dataset,
      closures: [
        { id: 'C1', airportId: 'AAA', start: 60, end: 80, label: 'Storm one' },
        { id: 'C2', airportId: 'AAA', start: 70, end: 95, label: 'Storm two' },
      ],
    })

    expect(output.flightById.F1.actualDeparture).toBe(95)
    expect(output.flightById.F1.actualArrival).toBe(155)
    expect(output.flightById.F1.delayMinutes).toBe(35)
    expect(output.flightById.F1.causeChain.map((link) => link.minutes)).toEqual([20, 15])
    expect(output.flightById.F1.causeChain.every((link) => link.code === 'WEATHER_CLOSURE')).toBe(true)
    expect(output.flightById.F3.actualDeparture).toBe(95)
    expect(output.flightById.F3.delayMinutes).toBe(5)
  })

  it('propagates a delayed arrival through the minimum turnaround', () => {
    const dataset = makeTestDataset()
    const output = simulateSimulation({
      dataset,
      closures: [
        { id: 'C1', airportId: 'BBB', start: 110, end: 140, label: 'Arrival closure' },
      ],
    })

    expect(output.flightById.F1.actualArrival).toBe(140)
    expect(output.flightById.F2.actualDeparture).toBe(170)
    expect(output.flightById.F2.delayMinutes).toBe(20)
    expect(output.flightById.F2.causeChain).toHaveLength(1)
    expect(output.flightById.F2.causeChain[0].code).toBe('ROTATION_KNOCKON')
    expect(output.flightById.F2.causeChain[0].sourceFlightId).toBe('F1')
    expect(output.flightById.F2.causeChain[0].minutes).toBe(20)
  })

  it('keeps every non-cancelled cause chain minute sum equal to delay', () => {
    const dataset = makeTestDataset()
    const output = simulateSimulation({
      dataset,
      closures: [
        { id: 'C1', airportId: 'AAA', start: 60, end: 80 },
        { id: 'C2', airportId: 'AAA', start: 70, end: 95 },
        { id: 'C3', airportId: 'BBB', start: 115, end: 165 },
      ],
    })

    for (const flight of output.flights) {
      if (flight.status === 'CANCELLED') continue
      const chainMinutes = flight.causeChain.reduce((sum, link) => sum + link.minutes, 0)
      expect(chainMinutes).toBe(flight.delayMinutes)
    }
  })

  it('cancels at the 180 minute departure threshold and cancels downstream legs', () => {
    const dataset = makeTestDataset()
    dataset.crews = dataset.crews.map((crew) => ({ ...crew, maxDutyMinutes: 600 }))
    const output = simulateSimulation({
      dataset,
      closures: [
        { id: 'C1', airportId: 'AAA', start: 60, end: 240, label: 'Long storm' },
      ],
    })

    expect(output.flightById.F1.status).toBe('CANCELLED')
    expect(output.flightById.F1.actualDeparture).toBeNull()
    expect(output.flightById.F1.causeChain[0].code).toBe('WEATHER_CLOSURE')
    expect(output.flightById.F1.causeChain[0].minutes).toBe(180)
    expect(output.flightById.F2.status).toBe('CANCELLED')
    expect(output.flightById.F2.causeChain[0].code).toBe('ROTATION_KNOCKON')
    expect(output.flightById.F2.causeChain[0].sourceFlightId).toBe('F1')
  })

  it('marks a crew timeout as a violation and continues safely', () => {
    const dataset = makeTestDataset()
    dataset.crews = dataset.crews.map((crew) =>
      crew.id === 'CR1' ? { ...crew, maxDutyMinutes: 100 } : crew,
    )
    const output = simulateSimulation({ dataset, closures: [] })

    expect(output.flightById.F1.status).toBe('CANCELLED')
    expect(output.flightById.F1.causeChain.some((link) => link.code === 'CREW_TIMEOUT')).toBe(true)
    expect(output.flightById.F2.status).toBe('CANCELLED')
    expect(output.kpis.crewViolations).toBe(1)
    expect(output.crews[0].violation).toBe(true)
    expect(output.crews[0].timedOutFlightIds).toEqual(['F1'])
  })

  it('counts missed connections without double counting cancelled transfers', () => {
    const dataset = makeTestDataset()
    const baseline = simulateSimulation({ dataset, closures: [] })
    expect(baseline.connections[0].status).toBe('MISSED')
    expect(baseline.connections[0].missedByMinutes).toBe(15)
    expect(baseline.kpis.strandedTransferPassengers).toBe(20)
    expect(baseline.kpis.strandedPassengers).toBe(20)

    const cancelled = simulateSimulation({
      dataset,
      closures: [],
      actions: [{ id: 'X1', type: 'CANCEL_FLIGHT', flightId: 'F1', cost: 1 }],
    })
    expect(cancelled.kpis.cancelledFlights).toBe(2)
    expect(cancelled.kpis.strandedPassengers).toBe(190)
    expect(cancelled.kpis.strandedTransferPassengers).toBe(0)
  })

  it('allows a closure to close end-of-day and delays the arrival beyond it', () => {
    const dataset = makeTestDataset()
    dataset.flights.push({
      id: 'F4',
      tailId: 'T3',
      legOrder: 1,
      origin: 'AAA',
      destination: 'BBB',
      departure: 1380,
      arrival: 1440,
      blockMinutes: 60,
      passengers: 10,
      turnaroundBeforeMinutes: null,
    })
    dataset.aircraft.push({ id: 'T3', flightIds: ['F4'] })
    const output = simulateSimulation({
      dataset,
      closures: [
        { id: 'C1', airportId: 'BBB', start: 1430, end: 1500, label: 'End of day closure' },
      ],
    })

    expect(output.flightById.F4.actualArrival).toBe(1500)
    expect(output.flightById.F4.delayMinutes).toBe(60)
    expect(output.flightById.F4.status).toBe('DELAYED')
  })
})
