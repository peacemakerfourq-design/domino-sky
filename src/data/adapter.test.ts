import { describe, expect, it } from 'vitest'
import bundledFlightNetwork from './flight_network.json'
import { loadBundledDataset, loadDataset } from './adapter'

function bundledCopy(): typeof bundledFlightNetwork {
  return structuredClone(bundledFlightNetwork)
}

describe('loadDataset', () => {
  it('loads the bundled organiser dataset with the expected entity counts', () => {
    const result = loadBundledDataset()

    expect(result.health.valid).toBe(true)
    expect(result.health.summary).toEqual({
      airports: 16,
      flights: 70,
      aircraft: 16,
      connections: 21,
      crews: 16,
      spares: 2,
      errors: 0,
      warnings: 0,
    })
    expect(result.dataset.meta.minTurnaroundMinutes).toBe(30)
    expect(result.dataset.meta.seatsPerAircraft).toBe(180)
    expect(result.dataset.flights[0]).toMatchObject({
      id: 'DS0101',
      tailId: 'VT-DS01',
      departure: 8 * 60,
      arrival: 8 * 60 + 50,
      turnaroundBeforeMinutes: null,
    })
    expect(result.dataset.crews[0].dutyStart).toBe(7 * 60 + 15)
    expect(result.dataset.spares[0].availableFrom).toBe(5 * 60)
    expect(result.dataset.aircraft[0]).toEqual({
      id: 'VT-DS01',
      flightIds: ['DS0101', 'DS0102', 'DS0103', 'DS0104', 'DS0105'],
    })

    const summary = result.health.issues.find((issue) => issue.code === 'dataset_summary')
    const turnaroundSummary = result.health.issues.find(
      (issue) => issue.code === 'turnaround_summary',
    )
    expect(summary).toMatchObject({ severity: 'info' })
    expect(summary?.message).toContain('16 airports')
    expect(summary?.message).toContain('70 flights')
    expect(turnaroundSummary).toMatchObject({ severity: 'info' })
    expect(turnaroundSummary?.message).toContain('Checked 54 scheduled turnarounds')
    expect(turnaroundSummary?.message).toContain('30-minute global minimum')
    expect(turnaroundSummary?.message).toContain('54 per-flight turnaround values')
    expect(turnaroundSummary?.message).toContain('found 0 violations')
  })

  it('reports malformed fields, duplicate ids, and nonpositive counts without throwing', () => {
    const raw = bundledCopy()
    raw.airports[0].capacity_per_hour = 0
    raw.flights[0].pax = 0
    raw.flights[1].dep = '25:00'
    raw.spare_aircraft[0].seats = 0
    raw.airports.push({ ...raw.airports[0] })

    const result = loadDataset(raw)
    const codes = result.health.issues.map((issue) => issue.code)

    expect(result.health.valid).toBe(false)
    expect(result.health.summary.errors).toBeGreaterThan(0)
    expect(codes).toContain('malformed_flight_departure')
    expect(codes).toContain('nonpositive_capacity')
    expect(codes).toContain('nonpositive_passengers')
    expect(codes).toContain('nonpositive_seats')
    expect(codes).toContain('duplicate_airport_id')
    expect(result.dataset.airports).toHaveLength(17)
    expect(result.dataset.flights).toHaveLength(70)
  })

  it('reports orphaned flight, crew, and aircraft references', () => {
    const raw = bundledCopy()
    raw.connections[0].from_flight = 'DS-NOT-FOUND'
    raw.crews[0].flight_ids.push('DS-NOT-FOUND')
    raw.crews[1].tail_id = 'VT-NOT-FOUND'

    const result = loadDataset(raw)
    const codes = result.health.issues.map((issue) => issue.code)

    expect(result.health.valid).toBe(false)
    expect(codes).toContain('orphan_connection_from_flight')
    expect(codes).toContain('orphan_crew_flight')
    expect(codes).toContain('missing_aircraft')
  })

  it('reports invalid connection airports and times, crew duty, and turnarounds', () => {
    const raw = bundledCopy()
    raw.connections[0].airport = 'DEL'
    raw.connections[0].min_connect_minutes = 999
    raw.crews[0].max_duty_mins = 1
    raw.flights[1].dep = '08:55'

    const result = loadDataset(raw)
    const codes = result.health.issues.map((issue) => issue.code)

    expect(result.health.valid).toBe(false)
    expect(codes).toContain('invalid_connection_airport')
    expect(codes).toContain('invalid_connection_time')
    expect(codes).toContain('invalid_crew_duty')
    expect(codes).toContain('impossible_turnaround')
  })

  it('returns an empty usable dataset for a malformed root', () => {
    const result = loadDataset(null)

    expect(result.health.valid).toBe(false)
    expect(result.health.summary).toMatchObject({
      airports: 0,
      flights: 0,
      aircraft: 0,
      connections: 0,
      crews: 0,
      spares: 0,
      errors: 1,
    })
    expect(result.health.issues[0].code).toBe('malformed_dataset')
    expect(result.dataset.meta.minTurnaroundMinutes).toBe(0)
  })
})
