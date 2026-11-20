import type {
  AirportClosure,
  AirportLoad,
  CauseCode,
  CauseLink,
  ConnectionResult,
  Crew,
  CrewResult,
  Flight,
  FlightResult,
  NormalizedDataset,
  PatientZero,
  RecoveryAction,
  SimulationInput,
  SimulationKpis,
  SimulationOutput,
} from '../domain/types'
import {
  DEFAULT_CANCELLATION_THRESHOLD_MINUTES,
  DEFAULT_RECOVERY_WEIGHTS,
  PATIENT_ZERO_RANKING,
  compareText,
} from './constants'

export { DEFAULT_CANCELLATION_THRESHOLD_MINUTES } from './constants'

interface ClosureContribution {
  closureId: string
  label: string
  minutes: number
}

interface ResolvedClosureShift {
  shiftedTo: number
  minutes: number
  contributions: ClosureContribution[]
}

interface FlightMeta {
  rootCauseId: string | null
  rootCauseLabel: string | null
  rootClosureIds: Set<string>
  rootSourceFlightId: string | null
  rootCrewIds: Set<string>
}

interface ActionPlan {
  cancellationFlightIds: Set<string>
  holdsByFlightId: Map<string, { minutes: number; actionId: string }>
  crewReassignmentsByFlightId: Map<string, string>
  activatedRotationIds: Set<string>
  effectiveTailByNominalTail: Map<string, string>
}

interface CandidateSchedule {
  actualDeparture: number
  actualArrival: number
  departureDelay: number
  arrivalDelay: number
  delayMinutes: number
  causeChain: CauseLink[]
  rootCauseId: string | null
  rootCauseLabel: string | null
  rootClosureIds: Set<string>
  rootSourceFlightId: string | null
  rootCrewIds: Set<string>
  notes: string[]
}

const VALID_CAUSE_CODES = new Set<CauseCode>([
  'WEATHER_CLOSURE',
  'ROTATION_KNOCKON',
  'CREW_TIMEOUT',
  'CREW_WAIT',
  'CONNECTION_HOLD',
  'RECOVERY_CANCEL',
  'RECOVERY_SPARE',
  'RECOVERY_HOLD',
  'RECOVERY_CREW',
])

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => compareText(a, b))
}

function compareFlightsWithinRotation(a: Flight, b: Flight): number {
  if (a.legOrder !== b.legOrder) return a.legOrder - b.legOrder
  if (a.departure !== b.departure) return a.departure - b.departure
  return compareText(a.id, b.id)
}

function closureLabel(closure: AirportClosure): string {
  return closure.label?.trim() || `Closure ${closure.id}`
}

function groupClosures(closures: AirportClosure[]): Map<string, AirportClosure[]> {
  const grouped = new Map<string, AirportClosure[]>()
  for (const closure of closures) {
    if (!Number.isFinite(closure.start) || !Number.isFinite(closure.end)) continue
    if (closure.end <= closure.start) continue
    const airportClosures = grouped.get(closure.airportId) ?? []
    airportClosures.push(closure)
    grouped.set(closure.airportId, airportClosures)
  }

  for (const airportClosures of grouped.values()) {
    airportClosures.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start
      if (a.end !== b.end) return b.end - a.end
      return compareText(a.id, b.id)
    })
  }
  return grouped
}

/**
 * Resolve a blocked event against every overlapping closure in order.
 *
 * Each link receives only the incremental minutes for which that closure was
 * responsible. For example, [500, 650) and [600, 700) produce 100 minutes for
 * the first closure and 50 for the second. This avoids double counting while
 * retaining every useful closure reference.
 */
function resolveClosureShift(
  eventTime: number,
  closures: AirportClosure[] | undefined,
): ResolvedClosureShift {
  if (!closures || closures.length === 0) {
    return { shiftedTo: eventTime, minutes: 0, contributions: [] }
  }

  let currentTime = eventTime
  const contributions: ClosureContribution[] = []
  for (const closure of closures) {
    if (currentTime >= closure.end) continue
    if (currentTime < closure.start) break
    const minutes = closure.end - currentTime
    if (minutes <= 0) continue
    currentTime = closure.end
    contributions.push({
      closureId: closure.id,
      label: closureLabel(closure),
      minutes,
    })
  }

  return {
    shiftedTo: currentTime,
    minutes: currentTime - eventTime,
    contributions,
  }
}

function nominalRotations(dataset: NormalizedDataset): Map<string, Flight[]> {
  const rotations = new Map<string, Flight[]>()
  for (const flight of dataset.flights) {
    const flights = rotations.get(flight.tailId) ?? []
    flights.push(flight)
    rotations.set(flight.tailId, flights)
  }
  for (const flights of rotations.values()) flights.sort(compareFlightsWithinRotation)
  return rotations
}

function rotationBase(
  dataset: NormalizedDataset,
  rotationFlights: Flight[],
): string {
  const flightIds = new Set(rotationFlights.map((flight) => flight.id))
  const assignedCrew = dataset.crews.find((crew) =>
    crew.flightIds.some((flightId) => flightIds.has(flightId)),
  )
  return assignedCrew?.base ?? rotationFlights[0]?.origin ?? ''
}

function minimumTurnaround(
  dataset: NormalizedDataset,
  flight: Flight,
  inputMinimum: number | undefined,
): number {
  const baseMinimum = inputMinimum !== undefined && finiteNonNegative(inputMinimum)
    ? inputMinimum
    : dataset.meta.minTurnaroundMinutes
  return Math.max(baseMinimum, flight.turnaroundBeforeMinutes ?? 0)
}

function buildActionPlan(
  input: SimulationInput,
  rotations: Map<string, Flight[]>,
): { plan: ActionPlan; validations: SimulationOutput['actionValidation'] } {
  const dataset = input.dataset
  const flightById = new Map(dataset.flights.map((flight) => [flight.id, flight]))
  const crewById = new Map(dataset.crews.map((crew) => [crew.id, crew]))
  const spareById = new Map(dataset.spares.map((spare) => [spare.id, spare]))
  const originalCrewByFlightId = new Map<string, string>()
  for (const crew of dataset.crews) {
    for (const flightId of crew.flightIds) {
      if (!originalCrewByFlightId.has(flightId)) originalCrewByFlightId.set(flightId, crew.id)
    }
  }

  const validations: SimulationOutput['actionValidation'] = []
  const seenActionIds = new Set<string>()
  const cancellationFlightIds = new Set<string>()
  const holdsByFlightId = new Map<string, { minutes: number; actionId: string }>()
  const crewReassignmentsByFlightId = new Map<string, string>()
  const effectiveTailByNominalTail = new Map<string, string>()
  for (const tailId of rotations.keys()) effectiveTailByNominalTail.set(tailId, tailId)
  const activatedRotations = new Set<string>()
  const activatedSpareIds = new Set<string>()
  const swappedPairs = new Set<string>()

  for (const action of input.actions ?? []) {
    let valid = true
    let reason = 'Action is valid.'

    if (seenActionIds.has(action.id)) {
      valid = false
      reason = `Duplicate action id "${action.id}".`
    }
    seenActionIds.add(action.id)

    if (valid && (!Number.isFinite(action.cost) || action.cost < 0)) {
      valid = false
      reason = 'Action cost must be a non-negative finite number.'
    }

    if (valid) {
      switch (action.type) {
        case 'CANCEL_FLIGHT': {
          if (!flightById.has(action.flightId)) {
            valid = false
            reason = `Unknown flight "${action.flightId}".`
          } else if (cancellationFlightIds.has(action.flightId)) {
            valid = false
            reason = `Flight "${action.flightId}" already has a cancellation action.`
          }
          break
        }
        case 'HOLD_FLIGHT': {
          if (!flightById.has(action.flightId)) {
            valid = false
            reason = `Unknown flight "${action.flightId}".`
          } else if (!Number.isFinite(action.holdMinutes) || action.holdMinutes <= 0) {
            valid = false
            reason = 'Hold minutes must be a positive finite number.'
          } else if (holdsByFlightId.has(action.flightId)) {
            valid = false
            reason = `Flight "${action.flightId}" already has a hold action.`
          }
          break
        }
        case 'REASSIGN_CREW': {
          const originalCrewId = originalCrewByFlightId.get(action.flightId)
          if (!flightById.has(action.flightId)) {
            valid = false
            reason = `Unknown flight "${action.flightId}".`
          } else if (!crewById.has(action.crewId)) {
            valid = false
            reason = `Unknown crew "${action.crewId}".`
          } else if (!originalCrewId) {
            valid = false
            reason = `Flight "${action.flightId}" has no assigned crew to replace.`
          } else if (originalCrewId === action.crewId) {
            valid = false
            reason = 'Replacement crew must differ from the original crew.'
          } else if (crewReassignmentsByFlightId.has(action.flightId)) {
            valid = false
            reason = `Flight "${action.flightId}" already has a crew reassignment.`
          }
          break
        }
        case 'ACTIVATE_SPARE': {
          const spare = spareById.get(action.spareId)
          const rotationFlights = rotations.get(action.rotationTailId)
          if (!spare) {
            valid = false
            reason = `Unknown spare aircraft "${action.spareId}".`
          } else if (!rotationFlights || rotationFlights.length === 0) {
            valid = false
            reason = `Unknown nominal rotation "${action.rotationTailId}".`
          } else if (activatedRotations.has(action.rotationTailId)) {
            valid = false
            reason = `Rotation "${action.rotationTailId}" already has a spare activation.`
          } else if (activatedSpareIds.has(action.spareId)) {
            valid = false
            reason = `Spare "${action.spareId}" is already assigned to another rotation.`
          } else {
            const base = rotationBase(dataset, rotationFlights)
            const firstDeparture = Math.min(...rotationFlights.map((flight) => flight.departure))
            const requiredSeats = Math.max(...rotationFlights.map((flight) => flight.passengers))
            if (spare.base !== base) {
              valid = false
              reason = `Spare "${spare.id}" is based at ${spare.base}; rotation requires base ${base}.`
            } else if (spare.availableFrom > firstDeparture) {
              valid = false
              reason = `Spare "${spare.id}" is unavailable until ${spare.availableFrom}; rotation starts at ${firstDeparture}.`
            } else if (spare.seats < requiredSeats) {
              valid = false
              reason = `Spare "${spare.id}" has ${spare.seats} seats; rotation requires ${requiredSeats}.`
            }
          }
          break
        }
        case 'SWAP_AIRCRAFT': {
          const pairKey = [action.tailIdA, action.tailIdB].sort().join('|')
          if (action.tailIdA === action.tailIdB) {
            valid = false
            reason = 'Aircraft swap requires two different tails.'
          } else if (!rotations.has(action.tailIdA)) {
            valid = false
            reason = `Unknown tail "${action.tailIdA}".`
          } else if (!rotations.has(action.tailIdB)) {
            valid = false
            reason = `Unknown tail "${action.tailIdB}".`
          } else if (swappedPairs.has(pairKey)) {
            valid = false
            reason = `Aircraft pair "${pairKey}" is already swapped.`
          }
          break
        }
      }
    }

    if (valid) {
      switch (action.type) {
        case 'CANCEL_FLIGHT':
          cancellationFlightIds.add(action.flightId)
          break
        case 'HOLD_FLIGHT':
          holdsByFlightId.set(action.flightId, {
            minutes: action.holdMinutes,
            actionId: action.id,
          })
          break
        case 'REASSIGN_CREW':
          crewReassignmentsByFlightId.set(action.flightId, action.crewId)
          break
        case 'ACTIVATE_SPARE':
          activatedRotations.add(action.rotationTailId)
          activatedSpareIds.add(action.spareId)
          effectiveTailByNominalTail.set(action.rotationTailId, action.spareId)
          break
        case 'SWAP_AIRCRAFT': {
          const pairKey = [action.tailIdA, action.tailIdB].sort().join('|')
          swappedPairs.add(pairKey)
          const tailA = effectiveTailByNominalTail.get(action.tailIdA) ?? action.tailIdA
          const tailB = effectiveTailByNominalTail.get(action.tailIdB) ?? action.tailIdB
          effectiveTailByNominalTail.set(action.tailIdA, tailB)
          effectiveTailByNominalTail.set(action.tailIdB, tailA)
          break
        }
      }
    }

    validations.push({ actionId: action.id, valid, reason })
  }

  return {
    plan: {
      cancellationFlightIds,
      holdsByFlightId,
      crewReassignmentsByFlightId,
      activatedRotationIds: activatedRotations,
      effectiveTailByNominalTail,
    },
    validations,
  }
}

function buildCrewAssignments(
  dataset: NormalizedDataset,
  reassignments: Map<string, string>,
): {
  assignmentsByCrewId: Map<string, Set<string>>
  crewByFlightId: Map<string, string>
} {
  const assignmentsByCrewId = new Map<string, Set<string>>()
  const originalCrewByFlightId = new Map<string, string>()
  for (const crew of dataset.crews) {
    assignmentsByCrewId.set(crew.id, new Set(crew.flightIds))
    for (const flightId of crew.flightIds) {
      if (!originalCrewByFlightId.has(flightId)) originalCrewByFlightId.set(flightId, crew.id)
    }
  }

  for (const [flightId, replacementCrewId] of reassignments) {
    const originalCrewId = originalCrewByFlightId.get(flightId)
    if (!originalCrewId) continue
    assignmentsByCrewId.get(originalCrewId)?.delete(flightId)
    const replacementAssignments = assignmentsByCrewId.get(replacementCrewId)
    if (replacementAssignments) replacementAssignments.add(flightId)
  }

  const crewByFlightId = new Map<string, string>()
  for (const [crewId, flightIds] of assignmentsByCrewId) {
    for (const flightId of flightIds) {
      if (!crewByFlightId.has(flightId)) crewByFlightId.set(flightId, crewId)
    }
  }
  return { assignmentsByCrewId, crewByFlightId }
}

function cancellationChain(
  action: RecoveryAction | undefined,
  previousMeta: FlightMeta | undefined,
  previousFlight: FlightResult | undefined,
  crewId: string | undefined,
  reason: string,
): { chain: CauseLink[]; rootCauseId: string | null; rootCauseLabel: string | null } {
  if (action?.type === 'CANCEL_FLIGHT') {
    return {
      chain: [
        {
          code: 'RECOVERY_CANCEL',
          minutes: 0,
          label: 'Recovery cancellation',
          detail: reason,
          flightId: action.flightId,
          actionId: action.id,
        },
      ],
      rootCauseId: action.id,
      rootCauseLabel: `Recovery action ${action.id}`,
    }
  }

  if (previousFlight?.status === 'CANCELLED') {
    return {
      chain: [
        {
          code: 'ROTATION_KNOCKON',
          minutes: 0,
          label: `Rotation knock-on from ${previousFlight.id}`,
          detail: reason,
          flightId: previousFlight.id,
          sourceFlightId: previousFlight.id,
          closureId: previousMeta?.rootClosureIds.size
            ? uniqueSorted(previousMeta.rootClosureIds)[0]
            : undefined,
        },
      ],
      rootCauseId: previousMeta?.rootCauseId ?? previousFlight.id,
      rootCauseLabel: previousMeta?.rootCauseLabel ?? `Flight ${previousFlight.id}`,
    }
  }

  return {
    chain: [
      {
        code: 'CREW_TIMEOUT',
        minutes: 0,
        label: crewId ? `Crew ${crewId} timed out` : 'Crew timed out',
        detail: reason,
        flightId: previousFlight?.id,
      },
    ],
    rootCauseId: crewId ?? previousMeta?.rootCauseId ?? null,
    rootCauseLabel: crewId
      ? `Crew ${crewId} duty timeout`
      : previousMeta?.rootCauseLabel ?? null,
  }
}

function calculateCandidateSchedule(input: {
  flight: Flight
  previousFlight: FlightResult | undefined
  previousMeta: FlightMeta | undefined
  crew: Crew | undefined
  holdMinutes: number
  holdActionId?: string
  minTurnaround: number
  closuresByAirport: Map<string, AirportClosure[]>
}): CandidateSchedule {
  const {
    flight,
    previousFlight,
    previousMeta,
    crew,
    holdMinutes,
    holdActionId,
    minTurnaround,
    closuresByAirport,
  } = input

  const propagationFloor = previousFlight?.actualArrival === null || previousFlight === undefined
    ? undefined
    : (previousFlight.actualArrival as number) + minTurnaround
  const propagationDelay = propagationFloor === undefined
    ? 0
    : Math.max(0, propagationFloor - flight.departure)
  const operationalFloor = Math.max(
    flight.departure,
    propagationFloor ?? Number.NEGATIVE_INFINITY,
    crew?.dutyStart ?? Number.NEGATIVE_INFINITY,
  )
  const crewWaitMinutes = crew
    ? Math.max(0, crew.dutyStart - Math.max(flight.departure, propagationFloor ?? Number.NEGATIVE_INFINITY))
    : 0
  const beforeClosureDeparture = operationalFloor + holdMinutes
  const departureClosure = resolveClosureShift(
    beforeClosureDeparture,
    closuresByAirport.get(flight.origin),
  )
  const actualDeparture = departureClosure.shiftedTo
  const projectedArrival = actualDeparture + flight.blockMinutes
  const arrivalClosure = resolveClosureShift(
    projectedArrival,
    closuresByAirport.get(flight.destination),
  )
  const actualArrival = arrivalClosure.shiftedTo
  const departureDelay = Math.max(0, actualDeparture - flight.departure)
  const arrivalDelay = Math.max(0, actualArrival - flight.arrival)
  const delayMinutes = Math.max(departureDelay, arrivalDelay)

  const chain: CauseLink[] = []
  const notes: string[] = []
  const rootClosureIds = new Set<string>()
  if (propagationDelay > 0 && previousFlight) {
    const inheritedClosureId = previousMeta?.rootClosureIds.size
      ? uniqueSorted(previousMeta.rootClosureIds)[0]
      : undefined
    chain.push({
      code: 'ROTATION_KNOCKON',
      minutes: propagationDelay,
      label: `Rotation knock-on from ${previousFlight.id}`,
      detail: `${previousFlight.id} arrives at ${previousFlight.actualArrival}; ${minTurnaround} minute turnaround gives earliest departure ${propagationFloor}.`,
      flightId: flight.id,
      sourceFlightId: previousFlight.id,
      closureId: inheritedClosureId,
    })
    notes.push(
      `Aircraft propagation from ${previousFlight.id} adds ${propagationDelay} minutes.`,
    )
    for (const closureId of previousMeta?.rootClosureIds ?? []) rootClosureIds.add(closureId)
  }

  for (const contribution of departureClosure.contributions) {
    rootClosureIds.add(contribution.closureId)
    chain.push({
      code: 'WEATHER_CLOSURE',
      minutes: contribution.minutes,
      label: contribution.label,
      detail: `Departure from ${flight.origin} was blocked by closure ${contribution.closureId}.`,
      flightId: flight.id,
      closureId: contribution.closureId,
    })
    notes.push(
      `Departure closure ${contribution.closureId} adds ${contribution.minutes} minutes.`,
    )
  }

  if (crewWaitMinutes > 0 && crew) {
    chain.push({
      code: 'CREW_WAIT',
      minutes: crewWaitMinutes,
      label: `Wait for crew ${crew.id}`,
      detail: `Crew ${crew.id} duty starts at ${crew.dutyStart}.`,
      flightId: flight.id,
    })
    notes.push(`Crew ${crew.id} is not available until ${crew.dutyStart}.`)
  }

  if (holdMinutes > 0) {
    chain.push({
      code: 'RECOVERY_HOLD',
      minutes: holdMinutes,
      label: 'Explicit recovery hold',
      detail: `Flight was explicitly held for ${holdMinutes} minutes.`,
      flightId: flight.id,
      actionId: holdActionId,
    })
    notes.push(`Explicit recovery hold adds ${holdMinutes} minutes.`)
  }

  for (const contribution of arrivalClosure.contributions) {
    rootClosureIds.add(contribution.closureId)
    chain.push({
      code: 'WEATHER_CLOSURE',
      minutes: contribution.minutes,
      label: contribution.label,
      detail: `Arrival at ${flight.destination} was blocked by closure ${contribution.closureId}.`,
      flightId: flight.id,
      closureId: contribution.closureId,
    })
    notes.push(
      `Arrival closure ${contribution.closureId} adds ${contribution.minutes} minutes.`,
    )
  }

  const ownClosureId = departureClosure.contributions[0]?.closureId
    ?? arrivalClosure.contributions[0]?.closureId
  let rootCauseId: string | null = null
  let rootCauseLabel: string | null = null
  let rootSourceFlightId: string | null = null
  const rootCrewIds = new Set<string>()

  if (propagationDelay > 0 && previousFlight) {
    rootCauseId = previousMeta?.rootCauseId ?? previousFlight.id
    rootCauseLabel = previousMeta?.rootCauseLabel ?? `Flight ${previousFlight.id}`
    rootSourceFlightId = previousMeta?.rootSourceFlightId ?? previousFlight.id
    for (const crewId of previousMeta?.rootCrewIds ?? []) rootCrewIds.add(crewId)
  } else if (ownClosureId) {
    const closure = [...input.closuresByAirport.values()]
      .flat()
      .find((candidate) => candidate.id === ownClosureId)
    rootCauseId = ownClosureId
    rootCauseLabel = closure ? closureLabel(closure) : `Closure ${ownClosureId}`
    rootSourceFlightId = flight.id
  } else if (crewWaitMinutes > 0 && crew) {
    rootCauseId = crew.id
    rootCauseLabel = `Crew ${crew.id} duty wait`
    rootSourceFlightId = flight.id
    rootCrewIds.add(crew.id)
  } else if (holdMinutes > 0) {
    rootCauseId = holdActionId ?? flight.id
    rootCauseLabel = holdActionId
      ? `Recovery action ${holdActionId}`
      : `Flight ${flight.id} hold`
    rootSourceFlightId = flight.id
  }

  return {
    actualDeparture,
    actualArrival,
    departureDelay,
    arrivalDelay,
    delayMinutes,
    causeChain: chain,
    rootCauseId,
    rootCauseLabel,
    rootClosureIds,
    rootSourceFlightId,
    rootCrewIds,
    notes,
  }
}

function primaryCauseCode(result: FlightResult): CauseCode {
  return result.causeChain[0]?.code ?? 'ROTATION_KNOCKON'
}

function buildConnectionResults(
  dataset: NormalizedDataset,
  flightById: Map<string, FlightResult>,
): ConnectionResult[] {
  return dataset.connections.map((connection) => {
    const feeder = flightById.get(connection.fromFlightId)
    const onward = flightById.get(connection.toFlightId)
    const feederCancelled = feeder?.status === 'CANCELLED'
    const onwardCancelled = onward?.status === 'CANCELLED'
    const canMeasureGap =
      feeder?.actualArrival !== null
      && feeder?.actualArrival !== undefined
      && onward?.actualDeparture !== null
      && onward?.actualDeparture !== undefined
    const actualGap = canMeasureGap
      ? (onward?.actualDeparture as number) - (feeder?.actualArrival as number)
      : null
    const made = !feederCancelled && !onwardCancelled && actualGap !== null
      && actualGap >= connection.minConnectMinutes
    const missedByMinutes = made || actualGap === null
      ? 0
      : Math.max(0, connection.minConnectMinutes - actualGap)
    let causeCode: CauseCode | null = null
    if (!made) {
      if (feederCancelled && feeder) causeCode = primaryCauseCode(feeder)
      else if (onwardCancelled && onward) causeCode = primaryCauseCode(onward)
      else causeCode = 'CONNECTION_HOLD'
    }
    return {
      id: connection.id,
      airport: connection.airport,
      fromFlightId: connection.fromFlightId,
      toFlightId: connection.toFlightId,
      passengers: connection.passengers,
      minConnectMinutes: connection.minConnectMinutes,
      status: made ? 'MADE' : 'MISSED',
      missedByMinutes,
      strandedPassengers: made ? 0 : connection.passengers,
      causeCode,
    }
  })
}

function buildAirportLoads(
  dataset: NormalizedDataset,
  flights: FlightResult[],
): AirportLoad[] {
  const byAirport = new Map<string, AirportLoad>()
  for (const airport of dataset.airports) {
    byAirport.set(airport.id, {
      airportId: airport.id,
      departures: 0,
      arrivals: 0,
      delayedDepartures: 0,
      delayedArrivals: 0,
    })
  }
  // Use the source flight data for airport IDs; FlightResult intentionally does
  // not duplicate origin/destination fields.
  const flightDataById = new Map(dataset.flights.map((flight) => [flight.id, flight]))
  for (const result of flights) {
    if (result.status === 'CANCELLED') continue
    const flight = flightDataById.get(result.id)
    if (!flight) continue
    const origin = byAirport.get(flight.origin)
    if (origin) {
      origin.departures += 1
      if (result.status === 'DELAYED') origin.delayedDepartures += 1
    }
    const destination = byAirport.get(flight.destination)
    if (destination) {
      destination.arrivals += 1
      if (result.status === 'DELAYED') destination.delayedArrivals += 1
    }
  }
  return dataset.airports.map((airport) => byAirport.get(airport.id) ?? {
    airportId: airport.id,
    departures: 0,
    arrivals: 0,
    delayedDepartures: 0,
    delayedArrivals: 0,
  })
}

function buildCrewResults(
  dataset: NormalizedDataset,
  assignmentsByCrewId: Map<string, Set<string>>,
  flightById: Map<string, FlightResult>,
  timedOutByCrewId: Map<string, Set<string>>,
  effectiveTailByNominalTail: Map<string, string>,
): CrewResult[] {
  const flightOrder = new Map(dataset.flights.map((flight, index) => [flight.id, index]))
  return dataset.crews.map((crew) => {
    const assignedFlightIds = [...(assignmentsByCrewId.get(crew.id) ?? new Set<string>())]
      .sort((a, b) => (flightOrder.get(a) ?? 0) - (flightOrder.get(b) ?? 0))
    const operated = assignedFlightIds
      .map((flightId) => flightById.get(flightId))
      .filter((flight): flight is FlightResult => Boolean(flight && flight.status !== 'CANCELLED'))
    const dutyEnd = operated.reduce<number | null>(
      (latest, flight) => (flight.actualArrival === null
        ? latest
        : latest === null ? flight.actualArrival : Math.max(latest, flight.actualArrival)),
      null,
    )
    const timedOutFlightIds = [...(timedOutByCrewId.get(crew.id) ?? new Set<string>())]
      .sort((a, b) => (flightOrder.get(a) ?? 0) - (flightOrder.get(b) ?? 0))
    const effectiveTailCounts = new Map<string, number>()
    for (const flightId of assignedFlightIds) {
      const flight = dataset.flights.find((candidate) => candidate.id === flightId)
      const effectiveTail = flight
        ? effectiveTailByNominalTail.get(flight.tailId) ?? flight.tailId
        : crew.tailId
      effectiveTailCounts.set(effectiveTail, (effectiveTailCounts.get(effectiveTail) ?? 0) + 1)
    }
    const effectiveTail = [...effectiveTailCounts.entries()]
      .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0]?.[0] ?? crew.tailId
    return {
      id: crew.id,
      tailId: effectiveTail,
      base: crew.base,
      dutyStart: crew.dutyStart,
      dutyEnd,
      dutyMinutes: dutyEnd === null ? 0 : Math.max(0, dutyEnd - crew.dutyStart),
      maxDutyMinutes: crew.maxDutyMinutes,
      violation: timedOutFlightIds.length > 0,
      timedOutFlightIds,
      assignedFlightIds,
    }
  })
}

function buildKpis(
  dataset: NormalizedDataset,
  flights: FlightResult[],
  connections: ConnectionResult[],
  crews: CrewResult[],
): SimulationKpis {
  const flightDataById = new Map(dataset.flights.map((flight) => [flight.id, flight]))
  const onTimeFlights = flights.filter((flight) => flight.status === 'ON_TIME').length
  const delayedFlights = flights.filter((flight) => flight.status === 'DELAYED').length
  const cancelledFlights = flights.filter((flight) => flight.status === 'CANCELLED').length
  const totalDelayMinutes = flights
    .filter((flight) => flight.status !== 'CANCELLED')
    .reduce((total, flight) => total + flight.delayMinutes, 0)
  const delayedPassengers = flights
    .filter((flight) => flight.status === 'DELAYED')
    .reduce((total, flight) => total + (flightDataById.get(flight.id)?.passengers ?? 0), 0)
  const cancelledPassengers = flights
    .filter((flight) => flight.status === 'CANCELLED')
    .reduce((total, flight) => total + (flightDataById.get(flight.id)?.passengers ?? 0), 0)

  // A transfer on a missed connection is counted only when neither connected
  // flight is cancelled. If one is cancelled, its own passenger count already
  // includes the transfer and adding the transfer again would double count it.
  const uniqueMissedTransferPassengers = connections
    .filter((connection) => {
      if (connection.status !== 'MISSED') return false
      const feeder = flights.find((flight) => flight.id === connection.fromFlightId)
      const onward = flights.find((flight) => flight.id === connection.toFlightId)
      return feeder?.status !== 'CANCELLED' && onward?.status !== 'CANCELLED'
    })
    .reduce((total, connection) => total + connection.passengers, 0)
  const strandedPassengers = cancelledPassengers + uniqueMissedTransferPassengers
  const crewViolations = crews.filter((crew) => crew.violation).length
  const worstDelayMinutes = flights
    .filter((flight) => flight.status !== 'CANCELLED')
    .reduce((maximum, flight) => Math.max(maximum, flight.delayMinutes), 0)
  const costScore =
    DEFAULT_RECOVERY_WEIGHTS.delayMinute * totalDelayMinutes
    + DEFAULT_RECOVERY_WEIGHTS.cancellation * cancelledFlights
    + DEFAULT_RECOVERY_WEIGHTS.strandedPassenger * strandedPassengers
    + DEFAULT_RECOVERY_WEIGHTS.crewViolation * crewViolations

  return {
    totalFlights: flights.length,
    onTimeFlights,
    delayedFlights,
    cancelledFlights,
    totalDelayMinutes,
    delayedPassengers,
    strandedPassengers,
    strandedTransferPassengers: uniqueMissedTransferPassengers,
    missedConnections: connections.filter((connection) => connection.status === 'MISSED').length,
    crewViolations,
    worstDelayMinutes,
    costScore,
  }
}

function buildPatientZeros(input: {
  dataset: NormalizedDataset
  closures: AirportClosure[]
  flights: FlightResult[]
  flightMetaById: Map<string, FlightMeta>
  connections: ConnectionResult[]
  crews: CrewResult[]
  closureImpact: SimulationOutput['closureImpact']
}): PatientZero[] {
  const { dataset, closures, flights, flightMetaById, connections, crews, closureImpact } = input
  const flightById = new Map(flights.map((flight) => [flight.id, flight]))
  const flightDataById = new Map(dataset.flights.map((flight) => [flight.id, flight]))
  const patients: PatientZero[] = []

  for (const closure of closures) {
    const impact = closureImpact[closure.id]
    if (!impact || (impact.affectedFlights === 0 && impact.downstreamDelayMinutes === 0 && impact.strandedPassengers === 0)) {
      continue
    }
    patients.push({
      id: closure.id,
      label: closureLabel(closure),
      kind: 'closure',
      affectedFlights: impact.affectedFlights,
      downstreamDelayMinutes: impact.downstreamDelayMinutes,
      strandedPassengers: impact.strandedPassengers,
    })
  }

  const sourceFlightIds = uniqueSorted(
    [...flightMetaById.values()]
      .map((meta) => meta.rootSourceFlightId)
      .filter((flightId): flightId is string => Boolean(flightId)),
  )
  for (const sourceFlightId of sourceFlightIds) {
    const affected = flights.filter((flight) =>
      flightMetaById.get(flight.id)?.rootSourceFlightId === sourceFlightId,
    )
    if (affected.length === 0) continue
    const affectedIds = new Set(affected.map((flight) => flight.id))
    const downstreamDelayMinutes = affected.reduce(
      (total, flight) => total + (flight.status === 'CANCELLED' ? 0 : flight.delayMinutes),
      0,
    )
    let strandedPassengers = affected
      .filter((flight) => flight.status === 'CANCELLED')
      .reduce((total, flight) => total + (flightDataById.get(flight.id)?.passengers ?? 0), 0)
    for (const connection of connections) {
      if (connection.status !== 'MISSED') continue
      const feeder = flightById.get(connection.fromFlightId)
      const onward = flightById.get(connection.toFlightId)
      if (feeder?.status === 'CANCELLED' || onward?.status === 'CANCELLED') continue
      if (!affectedIds.has(connection.fromFlightId) && !affectedIds.has(connection.toFlightId)) continue
      strandedPassengers += connection.passengers
      break
    }
    patients.push({
      id: sourceFlightId,
      label: `Flight ${sourceFlightId}`,
      kind: 'flight',
      affectedFlights: affected.length,
      downstreamDelayMinutes,
      strandedPassengers,
    })
  }

  for (const crew of crews.filter((candidate) => candidate.violation)) {
    const affected = flights.filter((flight) =>
      flightMetaById.get(flight.id)?.rootCrewIds.has(crew.id),
    )
    if (affected.length === 0) continue
    const affectedIds = new Set(affected.map((flight) => flight.id))
    let strandedPassengers = affected
      .filter((flight) => flight.status === 'CANCELLED')
      .reduce((total, flight) => total + (flightDataById.get(flight.id)?.passengers ?? 0), 0)
    for (const connection of connections) {
      if (connection.status !== 'MISSED') continue
      const feeder = flightById.get(connection.fromFlightId)
      const onward = flightById.get(connection.toFlightId)
      if (feeder?.status === 'CANCELLED' || onward?.status === 'CANCELLED') continue
      if (!affectedIds.has(connection.fromFlightId) && !affectedIds.has(connection.toFlightId)) continue
      strandedPassengers += connection.passengers
      break
    }
    patients.push({
      id: crew.id,
      label: `Crew ${crew.id}`,
      kind: 'crew',
      affectedFlights: affected.length,
      downstreamDelayMinutes: affected.reduce(
        (total, flight) => total + (flight.status === 'CANCELLED' ? 0 : flight.delayMinutes),
        0,
      ),
      strandedPassengers,
    })
  }

  const kindPriority: Record<PatientZero['kind'], number> = {
    closure: 0,
    flight: 1,
    crew: 2,
  }
  return patients.sort((a, b) => {
    const scoreA = a.downstreamDelayMinutes
      + a.strandedPassengers * PATIENT_ZERO_RANKING.strandedPassengerMinutes
      + a.affectedFlights * PATIENT_ZERO_RANKING.affectedFlightMinutes
    const scoreB = b.downstreamDelayMinutes
      + b.strandedPassengers * PATIENT_ZERO_RANKING.strandedPassengerMinutes
      + b.affectedFlights * PATIENT_ZERO_RANKING.affectedFlightMinutes
    return scoreB - scoreA
      || kindPriority[a.kind] - kindPriority[b.kind]
      || compareText(a.id, b.id)
  })
}

/**
 * Deterministically simulate a single operating day.
 *
 * The function is pure: it never mutates the input and never consults the
 * clock, a random source, or the network.
 */
export function simulateSimulation(input: SimulationInput): SimulationOutput {
  const dataset = input.dataset
  const rotations = nominalRotations(dataset)
  const closuresByAirport = groupClosures(input.closures ?? [])
  const { plan, validations } = buildActionPlan(input, rotations)
  const validActionIds = new Set(
    validations.filter((validation) => validation.valid).map((validation) => validation.actionId),
  )
  const {
    assignmentsByCrewId,
    crewByFlightId,
  } = buildCrewAssignments(dataset, plan.crewReassignmentsByFlightId)
  const crewById = new Map(dataset.crews.map((crew) => [crew.id, crew]))
  const timedOutByCrewId = new Map<string, Set<string>>()
  const flightMetaById = new Map<string, FlightMeta>()
  const resultsByFlightId = new Map<string, FlightResult>()
  const threshold = input.cancellationThresholdMinutes !== undefined
    && finiteNonNegative(input.cancellationThresholdMinutes)
    ? input.cancellationThresholdMinutes
    : DEFAULT_CANCELLATION_THRESHOLD_MINUTES

  for (const [nominalTailId, rotationFlights] of rotations) {
    let previousFlight: FlightResult | undefined
    let previousMeta: FlightMeta | undefined
    let rotationBlocked = false

    for (const flight of rotationFlights) {
      const effectiveTailId = plan.effectiveTailByNominalTail.get(nominalTailId) ?? nominalTailId
      const assignedCrewId = crewByFlightId.get(flight.id)
      const assignedCrew = assignedCrewId ? crewById.get(assignedCrewId) : undefined
      const explicitCancelAction = (input.actions ?? []).find(
        (action): action is Extract<RecoveryAction, { type: 'CANCEL_FLIGHT' }> =>
          action.type === 'CANCEL_FLIGHT'
          && action.flightId === flight.id
          && plan.cancellationFlightIds.has(flight.id),
      )
      const holdAction = plan.holdsByFlightId.get(flight.id)
      const holdMinutes = holdAction?.minutes ?? 0
      let result: FlightResult
      let meta: FlightMeta

      if (explicitCancelAction) {
        const cancellation = cancellationChain(
          explicitCancelAction,
          previousMeta,
          previousFlight,
          assignedCrewId,
          `Flight cancelled by recovery action ${explicitCancelAction.id}.`,
        )
        meta = {
          rootCauseId: cancellation.rootCauseId,
          rootCauseLabel: cancellation.rootCauseLabel,
          rootClosureIds: new Set(),
          rootSourceFlightId: flight.id,
          rootCrewIds: new Set(),
        }
        result = {
          id: flight.id,
          tailId: effectiveTailId,
          scheduledDeparture: flight.departure,
          scheduledArrival: flight.arrival,
          actualDeparture: null,
          actualArrival: null,
          delayMinutes: 0,
          status: 'CANCELLED',
          causeChain: cancellation.chain,
          rootCauseId: cancellation.rootCauseId,
          rootCauseLabel: cancellation.rootCauseLabel,
          crewId: assignedCrewId ?? null,
          notes: [cancellation.chain[0]?.detail ?? 'Flight cancelled.'],
        }
        rotationBlocked = true
      } else if (rotationBlocked && previousFlight) {
        const cancellation = cancellationChain(
          undefined,
          previousMeta,
          previousFlight,
          assignedCrewId,
          `The aircraft did not operate ${previousFlight.id}, so it cannot reach ${flight.origin}.`,
        )
        meta = {
          rootCauseId: cancellation.rootCauseId,
          rootCauseLabel: cancellation.rootCauseLabel,
          rootClosureIds: new Set(previousMeta?.rootClosureIds ?? []),
          rootSourceFlightId: previousMeta?.rootSourceFlightId ?? previousFlight.id,
          rootCrewIds: new Set(previousMeta?.rootCrewIds ?? []),
        }
        result = {
          id: flight.id,
          tailId: effectiveTailId,
          scheduledDeparture: flight.departure,
          scheduledArrival: flight.arrival,
          actualDeparture: null,
          actualArrival: null,
          delayMinutes: 0,
          status: 'CANCELLED',
          causeChain: cancellation.chain,
          rootCauseId: cancellation.rootCauseId,
          rootCauseLabel: cancellation.rootCauseLabel,
          crewId: assignedCrewId ?? null,
          notes: [cancellation.chain[0]?.detail ?? 'Following flight cancelled.'],
        }
      } else {
        const candidate = calculateCandidateSchedule({
          flight,
          previousFlight,
          previousMeta,
          crew: assignedCrew,
          holdMinutes,
          holdActionId: holdAction?.actionId,
          minTurnaround: minimumTurnaround(dataset, flight, input.minTurnaroundMinutes),
          closuresByAirport,
        })
        const crewTimeoutMinutes = assignedCrew
          ? Math.max(0, candidate.actualArrival - (assignedCrew.dutyStart + assignedCrew.maxDutyMinutes))
          : 0
        const reachesCancellationThreshold = candidate.departureDelay > 0
          && candidate.departureDelay >= threshold

        if (assignedCrew && crewTimeoutMinutes > 0) {
          const timedOutFlightIds = timedOutByCrewId.get(assignedCrew.id) ?? new Set<string>()
          timedOutFlightIds.add(flight.id)
          timedOutByCrewId.set(assignedCrew.id, timedOutFlightIds)
          const timeoutChain: CauseLink[] = [
            ...candidate.causeChain,
            {
              code: 'CREW_TIMEOUT',
              minutes: crewTimeoutMinutes,
              label: `Crew ${assignedCrew.id} timed out`,
              detail: `Projected arrival ${candidate.actualArrival} exceeds crew ${assignedCrew.id} duty limit ${assignedCrew.dutyStart + assignedCrew.maxDutyMinutes}.`,
              flightId: flight.id,
            },
          ]
          meta = {
            rootCauseId: assignedCrew.id,
            rootCauseLabel: `Crew ${assignedCrew.id} duty timeout`,
            rootClosureIds: new Set(candidate.rootClosureIds),
            rootSourceFlightId: flight.id,
            rootCrewIds: new Set([assignedCrew.id]),
          }
          result = {
            id: flight.id,
            tailId: effectiveTailId,
            scheduledDeparture: flight.departure,
            scheduledArrival: flight.arrival,
            actualDeparture: null,
            actualArrival: null,
            delayMinutes: 0,
            status: 'CANCELLED',
            causeChain: timeoutChain,
            rootCauseId: meta.rootCauseId,
            rootCauseLabel: meta.rootCauseLabel,
            crewId: assignedCrew.id,
            notes: [
              ...candidate.notes,
              `Crew ${assignedCrew.id} exceeds its ${assignedCrew.maxDutyMinutes} minute duty limit; flight timed out and was cancelled.`,
            ],
          }
          rotationBlocked = true
        } else if (reachesCancellationThreshold) {
          meta = {
            rootCauseId: candidate.rootCauseId,
            rootCauseLabel: candidate.rootCauseLabel,
            rootClosureIds: new Set(candidate.rootClosureIds),
            rootSourceFlightId: candidate.rootSourceFlightId,
            rootCrewIds: new Set(candidate.rootCrewIds),
          }
          result = {
            id: flight.id,
            tailId: effectiveTailId,
            scheduledDeparture: flight.departure,
            scheduledArrival: flight.arrival,
            actualDeparture: null,
            actualArrival: null,
            delayMinutes: 0,
            status: 'CANCELLED',
            causeChain: candidate.causeChain,
            rootCauseId: candidate.rootCauseId,
            rootCauseLabel: candidate.rootCauseLabel,
            crewId: assignedCrewId ?? null,
            notes: [
              ...candidate.notes,
              `Computed departure delay ${candidate.departureDelay} minutes reaches the cancellation threshold ${threshold}; flight cancelled.`,
            ],
          }
          rotationBlocked = true
        } else {
          const causeChain = [...candidate.causeChain]
          if (plan.activatedRotationIds.has(nominalTailId)) {
            const spareAction = (input.actions ?? []).find(
              (action): action is Extract<RecoveryAction, { type: 'ACTIVATE_SPARE' }> =>
                action.type === 'ACTIVATE_SPARE'
                && action.rotationTailId === nominalTailId
                && validActionIds.has(action.id),
            )
            causeChain.push({
              code: 'RECOVERY_SPARE',
              minutes: 0,
              label: 'Spare aircraft activated',
              detail: `Spare aircraft ${spareAction?.spareId ?? 'assigned'} operates this nominal rotation.`,
              flightId: flight.id,
              actionId: spareAction?.id,
            })
          }
          if (plan.crewReassignmentsByFlightId.has(flight.id)) {
            causeChain.push({
              code: 'RECOVERY_CREW',
              minutes: 0,
              label: 'Crew reassigned',
              detail: `Flight was assigned to replacement crew ${assignedCrewId}.`,
              flightId: flight.id,
              actionId: [...(input.actions ?? [])].find(
                (action): action is Extract<RecoveryAction, { type: 'REASSIGN_CREW' }> =>
                  action.type === 'REASSIGN_CREW' && action.flightId === flight.id,
              )?.id,
            })
          }
          meta = {
            rootCauseId: candidate.rootCauseId,
            rootCauseLabel: candidate.rootCauseLabel,
            rootClosureIds: new Set(candidate.rootClosureIds),
            rootSourceFlightId: candidate.rootSourceFlightId,
            rootCrewIds: new Set(candidate.rootCrewIds),
          }
          result = {
            id: flight.id,
            tailId: effectiveTailId,
            scheduledDeparture: flight.departure,
            scheduledArrival: flight.arrival,
            actualDeparture: candidate.actualDeparture,
            actualArrival: candidate.actualArrival,
            delayMinutes: candidate.delayMinutes,
            status: candidate.delayMinutes > 0 ? 'DELAYED' : 'ON_TIME',
            causeChain,
            rootCauseId: candidate.rootCauseId,
            rootCauseLabel: candidate.rootCauseLabel,
            crewId: assignedCrewId ?? null,
            notes: candidate.notes,
          }
        }
      }

      for (const link of result.causeChain) {
        if (!VALID_CAUSE_CODES.has(link.code)) {
          throw new Error(`Invalid cause code ${link.code} on flight ${flight.id}.`)
        }
      }
      resultsByFlightId.set(flight.id, result)
      flightMetaById.set(flight.id, meta)
      previousFlight = result
      previousMeta = meta
    }
  }

  const flights = dataset.flights.map((flight) => {
    const result = resultsByFlightId.get(flight.id)
    if (!result) throw new Error(`Flight ${flight.id} was not simulated.`)
    return {
      ...result,
      // This is kept out of FlightResult's public shape; passengers are added
      // only to the local KPI calculation below.
    }
  })
  const flightById = new Map(flights.map((flight) => [flight.id, flight]))
  const connections = buildConnectionResults(dataset, flightById)
  const crews = buildCrewResults(
    dataset,
    assignmentsByCrewId,
    flightById,
    timedOutByCrewId,
    plan.effectiveTailByNominalTail,
  )
  const airports = buildAirportLoads(dataset, flights)
  const kpis = buildKpis(dataset, flights, connections, crews)

  const closureImpact: SimulationOutput['closureImpact'] = {}
  for (const closure of input.closures ?? []) {
    closureImpact[closure.id] = {
      downstreamDelayMinutes: 0,
      strandedPassengers: 0,
      affectedFlights: 0,
    }
  }
  const flightDataById = new Map(dataset.flights.map((flight) => [flight.id, flight]))
  for (const flight of flights) {
    const meta = flightMetaById.get(flight.id)
    if (!meta) continue
    for (const closureId of uniqueSorted(meta.rootClosureIds)) {
      const impact = closureImpact[closureId]
      if (!impact) continue
      impact.affectedFlights += 1
      impact.downstreamDelayMinutes += flight.status === 'CANCELLED' ? 0 : flight.delayMinutes
    }
    if (flight.status === 'CANCELLED') {
      const closureId = uniqueSorted(meta.rootClosureIds)[0]
      const impact = closureId ? closureImpact[closureId] : undefined
      if (impact) {
        impact.strandedPassengers += flightDataById.get(flight.id)?.passengers ?? 0
      }
    }
  }
  for (const connection of connections) {
    if (connection.status !== 'MISSED') continue
    const feeder = flightById.get(connection.fromFlightId)
    const onward = flightById.get(connection.toFlightId)
    if (feeder?.status === 'CANCELLED' || onward?.status === 'CANCELLED') continue
    const closureIds = uniqueSorted([
      ...(flightMetaById.get(connection.fromFlightId)?.rootClosureIds ?? []),
      ...(flightMetaById.get(connection.toFlightId)?.rootClosureIds ?? []),
    ])
    const closureId = closureIds[0]
    if (closureId && closureImpact[closureId]) {
      closureImpact[closureId].strandedPassengers += connection.passengers
    }
  }

  const patientZeros = buildPatientZeros({
    dataset,
    closures: input.closures ?? [],
    flights,
    flightMetaById,
    connections,
    crews,
    closureImpact,
  })
  const flightByIdRecord: Record<string, FlightResult> = {}
  for (const flight of flights) flightByIdRecord[flight.id] = flight

  return {
    flights,
    flightById: flightByIdRecord,
    connections,
    crews,
    airports,
    kpis,
    patientZeros,
    actionValidation: validations,
    closureImpact,
  }
}
