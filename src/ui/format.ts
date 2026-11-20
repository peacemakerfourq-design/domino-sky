import type {
  CauseCode,
  FlightResult,
  RecoveryAction,
  SimulationOutput,
} from '../domain/types'

export function formatTime(totalMinutes: number | null | undefined): string {
  if (totalMinutes === null || totalMinutes === undefined || !Number.isFinite(totalMinutes)) {
    return '—'
  }
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  const hours = Math.floor(wrapped / 60)
  const minutes = wrapped % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function formatDelay(minutes: number): string {
  if (minutes <= 0) return 'On time'
  if (minutes < 60) return `+${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `+${hours}h${rest ? ` ${rest}m` : ''}`
}

export function signed(value: number): string {
  if (value === 0) return '0'
  return value > 0 ? `+${value}` : `${value}`
}

export function causeLabel(code: CauseCode): string {
  const labels: Record<CauseCode, string> = {
    WEATHER_CLOSURE: 'Weather closure',
    ROTATION_KNOCKON: 'Rotation knock-on',
    CREW_TIMEOUT: 'Crew duty timeout',
    CREW_WAIT: 'Crew unavailable',
    CONNECTION_HOLD: 'Connection hold',
    RECOVERY_CANCEL: 'Recovery cancellation',
    RECOVERY_SPARE: 'Spare aircraft',
    RECOVERY_HOLD: 'Recovery hold',
    RECOVERY_CREW: 'Crew reassignment',
  }
  return labels[code]
}

export function actionLabel(action: RecoveryAction): string {
  switch (action.type) {
    case 'CANCEL_FLIGHT':
      return `Cancel ${action.flightId}`
    case 'ACTIVATE_SPARE':
      return `Activate ${action.spareId} on ${action.rotationTailId}`
    case 'SWAP_AIRCRAFT':
      return `Swap ${action.tailIdA} ↔ ${action.tailIdB}`
    case 'HOLD_FLIGHT':
      return `Hold ${action.flightId} for ${action.holdMinutes}m`
    case 'REASSIGN_CREW':
      return `Assign ${action.crewId} to ${action.flightId}`
  }
}

export function actionKey(action: RecoveryAction): string {
  switch (action.type) {
    case 'CANCEL_FLIGHT':
      return `cancel:${action.flightId}`
    case 'ACTIVATE_SPARE':
      return `spare:${action.spareId}:${action.rotationTailId}`
    case 'SWAP_AIRCRAFT':
      return `swap:${[action.tailIdA, action.tailIdB].sort().join(':')}`
    case 'HOLD_FLIGHT':
      return `hold:${action.flightId}:${action.holdMinutes}`
    case 'REASSIGN_CREW':
      return `crew:${action.crewId}:${action.flightId}`
  }
}

export type ReplayStatus = 'PENDING' | 'DELAY_PENDING' | 'ACTIVE_DELAYED' | 'ON_TIME' | 'CANCELLED'

export function replayStatus(flight: FlightResult, time: number): ReplayStatus {
  if (flight.status === 'CANCELLED') {
    return time >= flight.scheduledDeparture ? 'CANCELLED' : 'PENDING'
  }
  if (flight.actualDeparture === null) return 'PENDING'
  if (time < flight.scheduledDeparture) return 'PENDING'
  if (flight.delayMinutes > 0 && time < flight.actualDeparture) return 'DELAY_PENDING'
  if (flight.actualDeparture <= time && (flight.actualArrival === null || time <= flight.actualArrival)) {
    return flight.delayMinutes > 0 ? 'ACTIVE_DELAYED' : 'ON_TIME'
  }
  return flight.delayMinutes > 0 ? 'ACTIVE_DELAYED' : 'ON_TIME'
}

export function replayKpis(
  simulation: SimulationOutput,
  time: number,
  passengerByFlight: Record<string, number>,
) {
  const delayedFlights = simulation.flights.filter(
    (flight) => flight.status === 'DELAYED' && flight.scheduledDeparture <= time,
  ).length
  const cancelledFlights = simulation.flights.filter(
    (flight) => flight.status === 'CANCELLED' && flight.scheduledDeparture <= time,
  ).length

  const missedConnections = simulation.connections.filter((connection) => {
    const feeder = simulation.flightById[connection.fromFlightId]
    const eventTime = feeder?.actualArrival ?? feeder?.scheduledDeparture ?? 0
    return connection.status === 'MISSED' && eventTime <= time
  }).length

  const cancelledPassengers = simulation.flights
    .filter(
      (flight) =>
        flight.status === 'CANCELLED' &&
        flight.scheduledDeparture <= time,
    )
    .reduce((sum, flight) => sum + (passengerByFlight[flight.id] ?? 0), 0)

  const strandedTransferPassengers = simulation.connections
    .filter((connection) => {
      const feeder = simulation.flightById[connection.fromFlightId]
      const eventTime = feeder?.actualArrival ?? feeder?.scheduledDeparture ?? 0
      return connection.status === 'MISSED' && eventTime <= time
    })
    .reduce((sum, connection) => sum + connection.strandedPassengers, 0)

  return {
    delayedFlights,
    cancelledFlights,
    missedConnections,
    strandedPassengers: cancelledPassengers + strandedTransferPassengers,
  }
}
