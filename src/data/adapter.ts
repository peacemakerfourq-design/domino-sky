import bundledFlightNetwork from './flight_network.json'
import type {
  Airport,
  Aircraft,
  Connection,
  Crew,
  DataHealthIssue,
  DatasetLoadResult,
  DatasetMeta,
  Flight,
  NormalizedDataset,
  SpareAircraft,
} from '../domain/types'

type RawObject = Record<string, unknown>
type IssueSeverity = DataHealthIssue['severity']

interface NumberResult {
  value: number
  valid: boolean
}

interface IntegerOptions {
  minimum?: number
  maximum?: number
  minimumCode?: string
  minimumMessage?: string
  maximumCode?: string
  maximumMessage?: string
}

interface ParsedMeta {
  value: DatasetMeta
  minTurnaroundValid: boolean
  seatsValid: boolean
}

interface ParsedAirport {
  value: Airport
  capacityValid: boolean
}

interface ParsedFlight {
  value: Flight
  departureValid: boolean
  arrivalValid: boolean
  scheduleValid: boolean
  blockValid: boolean
  passengersValid: boolean
  turnaroundValid: boolean
}

interface ParsedConnection {
  value: Connection
  passengersValid: boolean
  minConnectValid: boolean
}

interface ParsedCrew {
  value: Crew
  dutyStartValid: boolean
  maxDutyValid: boolean
}

interface ParsedSpare {
  value: SpareAircraft
  seatsValid: boolean
}

const AIRPORT_TIERS = new Set<Airport['tier']>(['mega_hub', 'regional_hub', 'spoke'])
const MINUTES_PER_DAY = 24 * 60

function isRawObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(object: RawObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function addIssue(
  issues: DataHealthIssue[],
  code: string,
  severity: IssueSeverity,
  message: string,
  entityIds: string[] = [],
): void {
  issues.push({ code, severity, message, entityIds })
}

function readRequiredString(
  record: RawObject,
  key: string,
  entity: string,
  field: string,
  entityId: string,
  issues: DataHealthIssue[],
): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    addIssue(
      issues,
      `malformed_${entity}_${field}`,
      'error',
      `${entity} "${entityId}" has an invalid ${field}: expected a non-empty string, received ${valueType(value)}.`,
      [entityId],
    )
    return ''
  }
  return value.trim()
}

function readInteger(
  record: RawObject,
  key: string,
  entity: string,
  field: string,
  entityId: string,
  issues: DataHealthIssue[],
  options: IntegerOptions = {},
): NumberResult {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    addIssue(
      issues,
      `malformed_${entity}_${field}`,
      'error',
      `${entity} "${entityId}" has an invalid ${field}: expected an integer, received ${valueType(value)}.`,
      [entityId],
    )
    return { value: 0, valid: false }
  }

  if (options.minimum !== undefined && value < options.minimum) {
    addIssue(
      issues,
      options.minimumCode ?? `malformed_${entity}_${field}`,
      'error',
      options.minimumMessage ?? `${entity} "${entityId}" has an invalid ${field}: ${value} is below ${options.minimum}.`,
      [entityId],
    )
    return { value: 0, valid: false }
  }

  if (options.maximum !== undefined && value > options.maximum) {
    addIssue(
      issues,
      options.maximumCode ?? `malformed_${entity}_${field}`,
      'error',
      options.maximumMessage ?? `${entity} "${entityId}" has an invalid ${field}: ${value} is above ${options.maximum}.`,
      [entityId],
    )
    return { value: 0, valid: false }
  }

  return { value, valid: true }
}

function readCoordinate(
  record: RawObject,
  key: string,
  entity: string,
  field: string,
  entityId: string,
  issues: DataHealthIssue[],
  minimum: number,
  maximum: number,
): NumberResult {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    addIssue(
      issues,
      `malformed_${entity}_${field}`,
      'error',
      `${entity} "${entityId}" has an invalid ${field}: expected a finite number from ${minimum} to ${maximum}.`,
      [entityId],
    )
    return { value: 0, valid: false }
  }
  return { value, valid: true }
}

function readTime(
  record: RawObject,
  key: string,
  entity: string,
  field: string,
  entityId: string,
  issues: DataHealthIssue[],
): NumberResult {
  const value = record[key]
  const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null
  if (!match) {
    addIssue(
      issues,
      `malformed_${entity}_${field}`,
      'error',
      `${entity} "${entityId}" has an invalid ${field}: expected HH:MM, received ${valueType(value)}.`,
      [entityId],
    )
    return { value: 0, valid: false }
  }
  return { value: Number(match[1]) * 60 + Number(match[2]), valid: true }
}

function readCollection(
  root: RawObject,
  key: string,
  label: string,
  issues: DataHealthIssue[],
  rootMalformed: boolean,
): unknown[] {
  if (rootMalformed) return []
  if (!hasOwn(root, key)) {
    addIssue(
      issues,
      'missing_collection',
      'error',
      `Dataset is missing the required ${label} collection.`,
      [key],
    )
    return []
  }
  if (!Array.isArray(root[key])) {
    addIssue(
      issues,
      'malformed_collection',
      'error',
      `Dataset ${label} collection must be an array.`,
      [key],
    )
    return []
  }
  return root[key]
}

function parseMeta(root: RawObject, issues: DataHealthIssue[], rootMalformed: boolean): ParsedMeta {
  const fallback: DatasetMeta = {
    dataset: '',
    operatingDay: '',
    minTurnaroundMinutes: 0,
    seatsPerAircraft: 0,
    notes: [],
  }

  if (rootMalformed) {
    return { value: fallback, minTurnaroundValid: false, seatsValid: false }
  }
  if (!isRawObject(root.meta)) {
    addIssue(
      issues,
      'malformed_meta',
      'error',
      `Dataset meta must be an object, received ${valueType(root.meta)}.`,
      ['meta'],
    )
    return { value: fallback, minTurnaroundValid: false, seatsValid: false }
  }

  const dataset = readRequiredString(root.meta, 'dataset', 'meta', 'dataset', 'meta', issues)
  const operatingDay = readRequiredString(
    root.meta,
    'operating_day',
    'meta',
    'operating_day',
    'meta',
    issues,
  )
  const minTurnaround = readInteger(
    root.meta,
    'min_turnaround_minutes',
    'meta',
    'min_turnaround_minutes',
    'meta',
    issues,
    {
      minimum: 0,
      maximum: MINUTES_PER_DAY,
      minimumCode: 'invalid_min_turnaround',
      minimumMessage: 'Meta minimum turnaround must be a non-negative number of minutes.',
      maximumCode: 'invalid_min_turnaround',
      maximumMessage: 'Meta minimum turnaround cannot exceed one operating day.',
    },
  )
  const seats = readInteger(root.meta, 'seats_per_aircraft', 'meta', 'seats_per_aircraft', 'meta', issues, {
    minimum: 1,
    minimumCode: 'nonpositive_capacity',
    minimumMessage: 'Meta seats per aircraft must be positive.',
  })

  let notes: string[] = []
  if (!Array.isArray(root.meta.notes)) {
    addIssue(
      issues,
      'malformed_meta_notes',
      'error',
      `Meta notes must be an array, received ${valueType(root.meta.notes)}.`,
      ['meta'],
    )
  } else {
    notes = root.meta.notes.map((note, index) => {
      if (typeof note !== 'string') {
        addIssue(
          issues,
          'malformed_meta_notes',
          'error',
          `Meta note ${index} must be a string, received ${valueType(note)}.`,
          ['meta'],
        )
        return ''
      }
      return note
    })
  }

  return {
    value: {
      dataset,
      operatingDay,
      minTurnaroundMinutes: minTurnaround.value,
      seatsPerAircraft: seats.value,
      notes,
    },
    minTurnaroundValid: minTurnaround.valid,
    seatsValid: seats.valid,
  }
}

function parseAirports(rawAirports: unknown[], issues: DataHealthIssue[]): ParsedAirport[] {
  const parsed: ParsedAirport[] = []

  rawAirports.forEach((item, index) => {
    if (!isRawObject(item)) {
      addIssue(
        issues,
        'malformed_airport',
        'error',
        `Airport at index ${index} must be an object, received ${valueType(item)}.`,
      )
      return
    }

    const id = readRequiredString(item, 'id', 'airport', 'id', 'airport', issues)
    if (!id) return

    const name = readRequiredString(item, 'name', 'airport', 'name', id, issues)
    const city = readRequiredString(item, 'city', 'airport', 'city', id, issues)
    const latitude = readCoordinate(item, 'lat', 'airport', 'latitude', id, issues, -90, 90)
    const longitude = readCoordinate(item, 'lng', 'airport', 'longitude', id, issues, -180, 180)
    const rawTier = item.tier
    let tier: Airport['tier'] = 'spoke'
    if (typeof rawTier !== 'string' || !AIRPORT_TIERS.has(rawTier as Airport['tier'])) {
      addIssue(
        issues,
        'malformed_airport_tier',
        'error',
        `Airport "${id}" has an invalid tier: expected mega_hub, regional_hub, or spoke.`,
        [id],
      )
    } else {
      tier = rawTier as Airport['tier']
    }

    const capacity = readInteger(item, 'capacity_per_hour', 'airport', 'capacity_per_hour', id, issues, {
      minimum: 1,
      minimumCode: 'nonpositive_capacity',
      minimumMessage: `Airport "${id}" capacity per hour must be positive.`,
    })

    parsed.push({
      value: {
        id,
        name,
        city,
        lat: latitude.value,
        lng: longitude.value,
        tier,
        capacityPerHour: capacity.value,
      },
      capacityValid: capacity.valid,
    })
  })

  return parsed
}

function parseFlights(
  rawFlights: unknown[],
  issues: DataHealthIssue[],
  meta: ParsedMeta,
): ParsedFlight[] {
  const parsed: ParsedFlight[] = []

  rawFlights.forEach((item, index) => {
    if (!isRawObject(item)) {
      addIssue(
        issues,
        'malformed_flight',
        'error',
        `Flight at index ${index} must be an object, received ${valueType(item)}.`,
      )
      return
    }

    const id = readRequiredString(item, 'flight_id', 'flight', 'id', 'flight', issues)
    if (!id) return

    const tailId = readRequiredString(item, 'tail_id', 'flight', 'tail_id', id, issues)
    const legOrder = readInteger(item, 'leg_order', 'flight', 'leg_order', id, issues, {
      minimum: 1,
      minimumCode: 'invalid_leg_order',
      minimumMessage: `Flight "${id}" leg order must be a positive integer.`,
    })
    const origin = readRequiredString(item, 'origin', 'flight', 'origin', id, issues)
    const destination = readRequiredString(item, 'destination', 'flight', 'destination', id, issues)
    const departure = readTime(item, 'dep', 'flight', 'departure', id, issues)
    const arrival = readTime(item, 'arr', 'flight', 'arrival', id, issues)
    const blockMinutes = readInteger(item, 'block_minutes', 'flight', 'block_minutes', id, issues, {
      minimum: 1,
      minimumCode: 'invalid_block_minutes',
      minimumMessage: `Flight "${id}" block minutes must be positive.`,
    })
    const passengers = readInteger(item, 'pax', 'flight', 'passengers', id, issues, {
      minimum: 1,
      minimumCode: 'nonpositive_passengers',
      minimumMessage: `Flight "${id}" passenger count must be positive.`,
    })

    let turnaroundBeforeMinutes: number | null = null
    let turnaroundValid = true
    if (item.turnaround_before_min !== null) {
      const turnaround = readInteger(
        item,
        'turnaround_before_min',
        'flight',
        'turnaround_before_min',
        id,
        issues,
        {
          minimum: 0,
          minimumCode: 'invalid_turnaround',
          minimumMessage: `Flight "${id}" turnaround must be non-negative.`,
        },
      )
      turnaroundBeforeMinutes = turnaround.valid ? turnaround.value : null
      turnaroundValid = turnaround.valid
    }

    const scheduleValid = departure.valid && arrival.valid && arrival.value > departure.value
    if (departure.valid && arrival.valid && arrival.value <= departure.value) {
      addIssue(
        issues,
        'invalid_flight_timing',
        'error',
        `Flight "${id}" must arrive after it departs on the same operating day.`,
        [id],
      )
    }

    if (scheduleValid && blockMinutes.valid && arrival.value - departure.value !== blockMinutes.value) {
      addIssue(
        issues,
        'inconsistent_block_minutes',
        'warning',
        `Flight "${id}" block minutes (${blockMinutes.value}) do not match its scheduled duration (${arrival.value - departure.value}).`,
        [id],
      )
    }

    if (origin && destination && origin === destination) {
      addIssue(
        issues,
        'same_origin_and_destination',
        'warning',
        `Flight "${id}" has the same origin and destination (${origin}).`,
        [id],
      )
    }

    if (meta.seatsValid && passengers.valid && passengers.value > meta.value.seatsPerAircraft) {
      addIssue(
        issues,
        'passengers_exceed_capacity',
        'warning',
        `Flight "${id}" carries ${passengers.value} passengers but aircraft capacity is ${meta.value.seatsPerAircraft}.`,
        [id],
      )
    }

    parsed.push({
      value: {
        id,
        tailId,
        legOrder: legOrder.value,
        origin,
        destination,
        departure: departure.value,
        arrival: arrival.value,
        blockMinutes: blockMinutes.value,
        passengers: passengers.value,
        turnaroundBeforeMinutes,
      },
      departureValid: departure.valid,
      arrivalValid: arrival.valid,
      scheduleValid,
      blockValid: blockMinutes.valid,
      passengersValid: passengers.valid,
      turnaroundValid,
    })
  })

  return parsed
}

function parseConnections(rawConnections: unknown[], issues: DataHealthIssue[]): ParsedConnection[] {
  const parsed: ParsedConnection[] = []

  rawConnections.forEach((item, index) => {
    if (!isRawObject(item)) {
      addIssue(
        issues,
        'malformed_connection',
        'error',
        `Connection at index ${index} must be an object, received ${valueType(item)}.`,
      )
      return
    }

    const id = readRequiredString(item, 'connection_id', 'connection', 'id', 'connection', issues)
    if (!id) return

    const airport = readRequiredString(item, 'airport', 'connection', 'airport', id, issues)
    const fromFlightId = readRequiredString(item, 'from_flight', 'connection', 'from_flight', id, issues)
    const toFlightId = readRequiredString(item, 'to_flight', 'connection', 'to_flight', id, issues)
    const passengers = readInteger(item, 'passengers', 'connection', 'passengers', id, issues, {
      minimum: 1,
      minimumCode: 'nonpositive_passengers',
      minimumMessage: `Connection "${id}" passenger count must be positive.`,
    })
    const minConnectMinutes = readInteger(
      item,
      'min_connect_minutes',
      'connection',
      'min_connect_minutes',
      id,
      issues,
      {
        minimum: 0,
        minimumCode: 'invalid_connection_time',
        minimumMessage: `Connection "${id}" minimum connect time must be non-negative.`,
      },
    )

    parsed.push({
      value: {
        id,
        airport,
        fromFlightId,
        toFlightId,
        passengers: passengers.value,
        minConnectMinutes: minConnectMinutes.value,
      },
      passengersValid: passengers.valid,
      minConnectValid: minConnectMinutes.valid,
    })
  })

  return parsed
}

function parseCrews(rawCrews: unknown[], issues: DataHealthIssue[]): ParsedCrew[] {
  const parsed: ParsedCrew[] = []

  rawCrews.forEach((item, index) => {
    if (!isRawObject(item)) {
      addIssue(
        issues,
        'malformed_crew',
        'error',
        `Crew at index ${index} must be an object, received ${valueType(item)}.`,
      )
      return
    }

    const id = readRequiredString(item, 'crew_id', 'crew', 'id', 'crew', issues)
    if (!id) return

    const tailId = readRequiredString(item, 'tail_id', 'crew', 'tail_id', id, issues)
    const base = readRequiredString(item, 'base', 'crew', 'base', id, issues)
    const dutyStart = readTime(item, 'duty_start', 'crew', 'duty_start', id, issues)
    const maxDutyMinutes = readInteger(item, 'max_duty_mins', 'crew', 'max_duty_mins', id, issues, {
      minimum: 1,
      maximum: MINUTES_PER_DAY,
      minimumCode: 'nonpositive_duty_limit',
      minimumMessage: `Crew "${id}" maximum duty must be positive.`,
      maximumCode: 'invalid_duty_limit',
      maximumMessage: `Crew "${id}" maximum duty cannot exceed one operating day.`,
    })

    const flightIds: string[] = []
    if (!Array.isArray(item.flight_ids)) {
      addIssue(
        issues,
        'malformed_crew_flight_ids',
        'error',
        `Crew "${id}" flight_ids must be an array, received ${valueType(item.flight_ids)}.`,
        [id],
      )
    } else {
      item.flight_ids.forEach((flightId, flightIndex) => {
        if (typeof flightId !== 'string' || flightId.trim() === '') {
          addIssue(
            issues,
            'malformed_crew_flight_id',
            'error',
            `Crew "${id}" flight id at index ${flightIndex} must be a non-empty string.`,
            [id],
          )
          return
        }
        flightIds.push(flightId.trim())
      })
    }

    parsed.push({
      value: {
        id,
        tailId,
        base,
        dutyStart: dutyStart.value,
        maxDutyMinutes: maxDutyMinutes.value,
        flightIds,
      },
      dutyStartValid: dutyStart.valid,
      maxDutyValid: maxDutyMinutes.valid,
    })
  })

  return parsed
}

function parseSpares(rawSpares: unknown[], issues: DataHealthIssue[]): ParsedSpare[] {
  const parsed: ParsedSpare[] = []

  rawSpares.forEach((item, index) => {
    if (!isRawObject(item)) {
      addIssue(
        issues,
        'malformed_spare',
        'error',
        `Spare aircraft at index ${index} must be an object, received ${valueType(item)}.`,
      )
      return
    }

    const id = readRequiredString(item, 'tail_id', 'spare', 'id', 'spare', issues)
    if (!id) return

    const base = readRequiredString(item, 'base', 'spare', 'base', id, issues)
    const availableFrom = readTime(item, 'available_from', 'spare', 'available_from', id, issues)
    const seats = readInteger(item, 'seats', 'spare', 'seats', id, issues, {
      minimum: 1,
      minimumCode: 'nonpositive_seats',
      minimumMessage: `Spare aircraft "${id}" seat count must be positive.`,
    })

    parsed.push({
      value: {
        id,
        base,
        availableFrom: availableFrom.value,
        seats: seats.value,
      },
      seatsValid: seats.valid,
    })
  })

  return parsed
}

function reportDuplicateIds(
  ids: string[],
  entity: string,
  issues: DataHealthIssue[],
): void {
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  for (const [id, count] of counts) {
    if (count <= 1) continue
    addIssue(
      issues,
      `duplicate_${entity}_id`,
      'error',
      `Duplicate ${entity} id "${id}" occurs ${count} times.`,
      [id],
    )
  }
}

function firstById<T extends { id: string }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    if (!result.has(item.id)) result.set(item.id, item)
  }
  return result
}

function compareFlightsWithinTail(a: Flight, b: Flight): number {
  if (a.legOrder !== b.legOrder) return a.legOrder - b.legOrder
  if (a.departure !== b.departure) return a.departure - b.departure
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

function buildAircraft(parsedFlights: ParsedFlight[]): {
  aircraft: Aircraft[]
  flightsByTail: Map<string, ParsedFlight[]>
} {
  const flightsByTail = new Map<string, ParsedFlight[]>()
  for (const flight of parsedFlights) {
    if (!flight.value.tailId) continue
    const group = flightsByTail.get(flight.value.tailId) ?? []
    group.push(flight)
    flightsByTail.set(flight.value.tailId, group)
  }

  const aircraft: Aircraft[] = []
  for (const [id, group] of flightsByTail) {
    const sorted = [...group].sort((a, b) => compareFlightsWithinTail(a.value, b.value))
    const seenFlightIds = new Set<string>()
    const flightIds: string[] = []
    for (const flight of sorted) {
      if (seenFlightIds.has(flight.value.id)) continue
      seenFlightIds.add(flight.value.id)
      flightIds.push(flight.value.id)
    }
    aircraft.push({ id, flightIds })
  }

  return { aircraft, flightsByTail }
}

export function loadDataset(raw: unknown): DatasetLoadResult {
  const issues: DataHealthIssue[] = []
  const rootMalformed = !isRawObject(raw)
  const root: RawObject = rootMalformed ? {} : raw

  if (rootMalformed) {
    addIssue(
      issues,
      'malformed_dataset',
      'error',
      `Dataset root must be an object, received ${valueType(raw)}.`,
    )
  }

  const parsedMeta = parseMeta(root, issues, rootMalformed)
  const rawAirports = readCollection(root, 'airports', 'airports', issues, rootMalformed)
  const rawFlights = readCollection(root, 'flights', 'flights', issues, rootMalformed)
  const rawConnections = readCollection(root, 'connections', 'connections', issues, rootMalformed)
  const rawCrews = readCollection(root, 'crews', 'crews', issues, rootMalformed)
  const rawSpares = readCollection(root, 'spare_aircraft', 'spare aircraft', issues, rootMalformed)

  const parsedAirports = parseAirports(rawAirports, issues)
  const parsedFlights = parseFlights(rawFlights, issues, parsedMeta)
  const parsedConnections = parseConnections(rawConnections, issues)
  const parsedCrews = parseCrews(rawCrews, issues)
  const parsedSpares = parseSpares(rawSpares, issues)

  const airports = parsedAirports.map((item) => item.value)
  const flights = parsedFlights.map((item) => item.value)
  const connections = parsedConnections.map((item) => item.value)
  const crews = parsedCrews.map((item) => item.value)
  const spares = parsedSpares.map((item) => item.value)

  reportDuplicateIds(
    airports.map((airport) => airport.id),
    'airport',
    issues,
  )
  reportDuplicateIds(
    flights.map((flight) => flight.id),
    'flight',
    issues,
  )
  reportDuplicateIds(
    connections.map((connection) => connection.id),
    'connection',
    issues,
  )
  reportDuplicateIds(
    crews.map((crew) => crew.id),
    'crew',
    issues,
  )
  reportDuplicateIds(
    spares.map((spare) => spare.id),
    'spare',
    issues,
  )

  const { aircraft, flightsByTail } = buildAircraft(parsedFlights)
  const airportById = firstById(airports)
  const flightById = firstById(parsedFlights.map((item) => item.value))
  const aircraftById = firstById(aircraft)
  const parsedFlightById = new Map<string, ParsedFlight>()
  for (const flight of parsedFlights) {
    if (!parsedFlightById.has(flight.value.id)) parsedFlightById.set(flight.value.id, flight)
  }

  for (const flight of flights) {
    if (flight.origin && !airportById.has(flight.origin)) {
      addIssue(
        issues,
        'orphan_flight_origin',
        'error',
        `Flight "${flight.id}" references unknown origin airport "${flight.origin}".`,
        [flight.id],
      )
    }
    if (flight.destination && !airportById.has(flight.destination)) {
      addIssue(
        issues,
        'orphan_flight_destination',
        'error',
        `Flight "${flight.id}" references unknown destination airport "${flight.destination}".`,
        [flight.id],
      )
    }
    if (!flight.tailId || !aircraftById.has(flight.tailId)) {
      addIssue(
        issues,
        'missing_aircraft',
        'error',
        `Flight "${flight.id}" is not assigned to an aircraft tail.`,
        [flight.id],
      )
    }
  }

  for (const connection of parsedConnections) {
    const value = connection.value
    const fromFlight = flightById.get(value.fromFlightId)
    const toFlight = flightById.get(value.toFlightId)

    if (value.airport && !airportById.has(value.airport)) {
      addIssue(
        issues,
        'orphan_connection_airport',
        'error',
        `Connection "${value.id}" references unknown airport "${value.airport}".`,
        [value.id],
      )
    }
    if (value.fromFlightId && !fromFlight) {
      addIssue(
        issues,
        'orphan_connection_from_flight',
        'error',
        `Connection "${value.id}" references unknown from-flight "${value.fromFlightId}".`,
        [value.id],
      )
    }
    if (value.toFlightId && !toFlight) {
      addIssue(
        issues,
        'orphan_connection_to_flight',
        'error',
        `Connection "${value.id}" references unknown to-flight "${value.toFlightId}".`,
        [value.id],
      )
    }
    if (fromFlight && toFlight && fromFlight.id === toFlight.id) {
      addIssue(
        issues,
        'invalid_connection_flight_pair',
        'error',
        `Connection "${value.id}" cannot connect a flight to itself.`,
        [value.id],
      )
    }

    if (fromFlight && toFlight && value.airport) {
      const fromAirport = fromFlight.destination
      const toAirport = toFlight.origin
      if ((fromAirport && fromAirport !== value.airport) || (toAirport && toAirport !== value.airport)) {
        addIssue(
          issues,
          'invalid_connection_airport',
          'error',
          `Connection "${value.id}" is at "${value.airport}", but its flights connect ${fromAirport || 'unknown'} to ${toAirport || 'unknown'}.`,
          [value.id, fromFlight.id, toFlight.id],
        )
      }
    }

    if (
      fromFlight &&
      toFlight &&
      connection.minConnectValid &&
      parsedFlightById.get(fromFlight.id)?.scheduleValid &&
      parsedFlightById.get(toFlight.id)?.scheduleValid
    ) {
      const availableMinutes = toFlight.departure - fromFlight.arrival
      if (availableMinutes < value.minConnectMinutes) {
        addIssue(
          issues,
          'invalid_connection_time',
          'error',
          `Connection "${value.id}" allows ${availableMinutes} minutes but requires at least ${value.minConnectMinutes} minutes.`,
          [value.id, fromFlight.id, toFlight.id],
        )
      }
    }

    if (
      connection.passengersValid &&
      fromFlight &&
      parsedFlightById.get(fromFlight.id)?.passengersValid &&
      value.passengers > fromFlight.passengers
    ) {
      addIssue(
        issues,
        'connection_passengers_exceed_flight',
        'warning',
        `Connection "${value.id}" carries ${value.passengers} passengers, more than flight "${fromFlight.id}" carries.`,
        [value.id, fromFlight.id],
      )
    }
    if (
      connection.passengersValid &&
      toFlight &&
      parsedFlightById.get(toFlight.id)?.passengersValid &&
      value.passengers > toFlight.passengers
    ) {
      addIssue(
        issues,
        'connection_passengers_exceed_flight',
        'warning',
        `Connection "${value.id}" carries ${value.passengers} passengers, more than flight "${toFlight.id}" carries.`,
        [value.id, toFlight.id],
      )
    }
  }

  const crewIdsByFlight = new Map<string, string[]>()
  for (const crew of parsedCrews) {
    const value = crew.value
    if (value.base && !airportById.has(value.base)) {
      addIssue(
        issues,
        'orphan_crew_airport',
        'error',
        `Crew "${value.id}" references unknown base airport "${value.base}".`,
        [value.id],
      )
    }
    if (!value.tailId || !aircraftById.has(value.tailId)) {
      addIssue(
        issues,
        'missing_aircraft',
        'error',
        `Crew "${value.id}" references missing aircraft tail "${value.tailId}".`,
        [value.id],
      )
    }

    const seenFlightIds = new Set<string>()
    const assignedFlights: Flight[] = []
    for (const flightId of value.flightIds) {
      if (seenFlightIds.has(flightId)) {
        addIssue(
          issues,
          'duplicate_crew_flight',
          'error',
          `Crew "${value.id}" repeats flight reference "${flightId}".`,
          [value.id, flightId],
        )
        continue
      }
      seenFlightIds.add(flightId)

      const flight = flightById.get(flightId)
      if (!flight) {
        addIssue(
          issues,
          'orphan_crew_flight',
          'error',
          `Crew "${value.id}" references unknown flight "${flightId}".`,
          [value.id, flightId],
        )
        continue
      }

      assignedFlights.push(flight)
      const assignedCrews = crewIdsByFlight.get(flightId) ?? []
      assignedCrews.push(value.id)
      crewIdsByFlight.set(flightId, assignedCrews)

      if (value.tailId && flight.tailId && value.tailId !== flight.tailId) {
        addIssue(
          issues,
          'invalid_crew_assignment',
          'error',
          `Crew "${value.id}" is assigned to flight "${flightId}" on tail "${flight.tailId}", not its declared tail "${value.tailId}".`,
          [value.id, flightId],
        )
      }
    }

    if (assignedFlights.length === 0) {
      addIssue(
        issues,
        'missing_crew_assignment',
        'error',
        `Crew "${value.id}" has no valid flight assignments.`,
        [value.id],
      )
    }

    if (crew.dutyStartValid && crew.maxDutyValid && assignedFlights.length > 0) {
      const departures = assignedFlights
        .filter((flight) => parsedFlightById.get(flight.id)?.departureValid)
        .map((flight) => flight.departure)
      const arrivals = assignedFlights
        .filter((flight) => parsedFlightById.get(flight.id)?.arrivalValid)
        .map((flight) => flight.arrival)

      if (departures.length > 0) {
        const firstDeparture = Math.min(...departures)
        if (firstDeparture < value.dutyStart) {
          addIssue(
            issues,
            'invalid_crew_duty',
            'error',
            `Crew "${value.id}" duty starts at minute ${value.dutyStart}, after its first flight departs at minute ${firstDeparture}.`,
            [value.id],
          )
        }
      }
      if (arrivals.length > 0) {
        const dutyEnd = Math.max(...arrivals)
        const dutyMinutes = dutyEnd - value.dutyStart
        if (dutyMinutes < 0) {
          addIssue(
            issues,
            'invalid_crew_duty',
            'error',
            `Crew "${value.id}" duty ends before it starts.`,
            [value.id],
          )
        } else if (dutyMinutes > value.maxDutyMinutes) {
          addIssue(
            issues,
            'invalid_crew_duty',
            'error',
            `Crew "${value.id}" requires ${dutyMinutes} duty minutes, exceeding its ${value.maxDutyMinutes}-minute limit.`,
            [value.id],
          )
        }
      }
    }
  }

  for (const flight of flights) {
    const assignedCrews = crewIdsByFlight.get(flight.id) ?? []
    if (assignedCrews.length === 0) {
      addIssue(
        issues,
        'missing_crew_assignment',
        'error',
        `Flight "${flight.id}" has no crew assignment.`,
        [flight.id],
      )
    } else if (assignedCrews.length > 1) {
      addIssue(
        issues,
        'duplicate_crew_assignment',
        'error',
        `Flight "${flight.id}" is assigned to multiple crews: ${assignedCrews.join(', ')}.`,
        [flight.id, ...assignedCrews],
      )
    }
  }

  for (const spare of spares) {
    if (spare.base && !airportById.has(spare.base)) {
      addIssue(
        issues,
        'orphan_spare_airport',
        'error',
        `Spare aircraft "${spare.id}" references unknown base airport "${spare.base}".`,
        [spare.id],
      )
    }
    if (aircraftById.has(spare.id)) {
      addIssue(
        issues,
        'duplicate_aircraft_id',
        'error',
        `Spare aircraft id "${spare.id}" duplicates an active aircraft id.`,
        [spare.id],
      )
    }
  }

  let turnaroundChecks = 0
  let turnaroundViolations = 0
  let turnaroundOverrides = 0
  let maximumRequiredTurnaround = parsedMeta.value.minTurnaroundMinutes

  for (const [tailId, group] of flightsByTail) {
    const sorted = [...group].sort((a, b) => compareFlightsWithinTail(a.value, b.value))
    const legOrders = sorted.map((flight) => flight.value.legOrder)
    const uniqueLegOrders = [...new Set(legOrders)].sort((a, b) => a - b)
    const duplicateLegOrders = uniqueLegOrders.filter(
      (legOrder) => legOrders.filter((candidate) => candidate === legOrder).length > 1,
    )
    for (const legOrder of duplicateLegOrders) {
      const matchingIds = sorted
        .filter((flight) => flight.value.legOrder === legOrder)
        .map((flight) => flight.value.id)
      addIssue(
        issues,
        'duplicate_leg_order',
        'error',
        `Aircraft "${tailId}" has multiple flights at leg order ${legOrder}.`,
        [tailId, ...matchingIds],
      )
    }

    for (let index = 0; index < uniqueLegOrders.length; index += 1) {
      const expectedLegOrder = index + 1
      if (uniqueLegOrders[index] !== expectedLegOrder) {
        addIssue(
          issues,
          'invalid_leg_sequence',
          'error',
          `Aircraft "${tailId}" does not have a continuous leg sequence starting at 1.`,
          [tailId],
        )
        break
      }
    }

    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]
      const current = sorted[index]
      turnaroundChecks += 1
      if (current.turnaroundValid && current.value.turnaroundBeforeMinutes !== null) {
        turnaroundOverrides += 1
      }

      const requiredTurnaround = Math.max(
        parsedMeta.minTurnaroundValid ? parsedMeta.value.minTurnaroundMinutes : 0,
        current.turnaroundValid ? (current.value.turnaroundBeforeMinutes ?? 0) : 0,
      )
      maximumRequiredTurnaround = Math.max(maximumRequiredTurnaround, requiredTurnaround)

      if (
        previous.value.destination &&
        current.value.origin &&
        previous.value.destination !== current.value.origin
      ) {
        addIssue(
          issues,
          'invalid_turnaround_location',
          'error',
          `Flight "${current.value.id}" departs from "${current.value.origin}", but preceding flight "${previous.value.id}" arrives at "${previous.value.destination}".`,
          [previous.value.id, current.value.id],
        )
      }

      if (previous.arrivalValid && current.departureValid) {
        const availableTurnaround = current.value.departure - previous.value.arrival
        if (availableTurnaround < requiredTurnaround) {
          turnaroundViolations += 1
          addIssue(
            issues,
            'impossible_turnaround',
            'error',
            `Turnaround from flight "${previous.value.id}" to "${current.value.id}" allows ${availableTurnaround} minutes but requires ${requiredTurnaround} minutes.`,
            [previous.value.id, current.value.id],
          )
        }
      }
    }
  }

  const departuresByAirportHour = new Map<string, number>()
  for (const flight of parsedFlights) {
    if (!flight.departureValid || !flight.value.origin) continue
    const hour = Math.floor(flight.value.departure / 60)
    const key = `${flight.value.origin}|${hour}`
    departuresByAirportHour.set(key, (departuresByAirportHour.get(key) ?? 0) + 1)
  }
  for (const airport of parsedAirports) {
    if (!airport.capacityValid) continue
    for (let hour = 0; hour < 24; hour += 1) {
      const departures = departuresByAirportHour.get(`${airport.value.id}|${hour}`) ?? 0
      if (departures <= airport.value.capacityPerHour) continue
      addIssue(
        issues,
        'airport_capacity_exceeded',
        'warning',
        `Airport "${airport.value.id}" has ${departures} departures at ${String(hour).padStart(2, '0')}:00, exceeding its hourly capacity of ${airport.value.capacityPerHour}.`,
        [airport.value.id],
      )
    }
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.filter((issue) => issue.severity === 'warning').length

  addIssue(
    issues,
    'dataset_summary',
    'info',
    `Loaded ${airports.length} airports, ${flights.length} flights, ${aircraft.length} aircraft, ${connections.length} connections, ${crews.length} crews, and ${spares.length} spares; found ${errors} errors and ${warnings} warnings.`,
  )
  addIssue(
    issues,
    'turnaround_summary',
    'info',
    `Checked ${turnaroundChecks} scheduled turnarounds using the ${parsedMeta.value.minTurnaroundMinutes}-minute global minimum and ${turnaroundOverrides} per-flight turnaround values; found ${turnaroundViolations} violations.`,
  )

  const dataset: NormalizedDataset = {
    meta: parsedMeta.value,
    airports,
    flights,
    aircraft,
    connections,
    crews,
    spares,
  }

  return {
    dataset,
    health: {
      valid: errors === 0,
      issues,
      summary: {
        airports: airports.length,
        flights: flights.length,
        aircraft: aircraft.length,
        connections: connections.length,
        crews: crews.length,
        spares: spares.length,
        errors,
        warnings,
      },
    },
  }
}

export function loadBundledDataset(): DatasetLoadResult {
  return loadDataset(bundledFlightNetwork)
}
