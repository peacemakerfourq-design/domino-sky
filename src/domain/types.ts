export type Minutes = number

export interface Airport {
  id: string
  name: string
  city: string
  lat: number
  lng: number
  tier: 'mega_hub' | 'regional_hub' | 'spoke'
  capacityPerHour: number
}

export interface Flight {
  id: string
  tailId: string
  legOrder: number
  origin: string
  destination: string
  departure: Minutes
  arrival: Minutes
  blockMinutes: Minutes
  passengers: number
  turnaroundBeforeMinutes: number | null
}

export interface Aircraft {
  id: string
  flightIds: string[]
}

export interface Connection {
  id: string
  airport: string
  fromFlightId: string
  toFlightId: string
  passengers: number
  minConnectMinutes: Minutes
}

export interface Crew {
  id: string
  tailId: string
  base: string
  dutyStart: Minutes
  maxDutyMinutes: Minutes
  flightIds: string[]
}

export interface SpareAircraft {
  id: string
  base: string
  availableFrom: Minutes
  seats: number
}

export interface DatasetMeta {
  dataset: string
  operatingDay: string
  minTurnaroundMinutes: Minutes
  seatsPerAircraft: number
  notes: string[]
}

export interface NormalizedDataset {
  meta: DatasetMeta
  airports: Airport[]
  flights: Flight[]
  aircraft: Aircraft[]
  connections: Connection[]
  crews: Crew[]
  spares: SpareAircraft[]
}

export type HealthSeverity = 'error' | 'warning' | 'info'

export interface DataHealthIssue {
  code: string
  severity: HealthSeverity
  message: string
  entityIds: string[]
}

export interface DatasetLoadResult {
  dataset: NormalizedDataset
  health: {
    valid: boolean
    issues: DataHealthIssue[]
    summary: {
      airports: number
      flights: number
      aircraft: number
      connections: number
      crews: number
      spares: number
      errors: number
      warnings: number
    }
  }
}

export type CauseCode =
  | 'WEATHER_CLOSURE'
  | 'ROTATION_KNOCKON'
  | 'CREW_TIMEOUT'
  | 'CREW_WAIT'
  | 'CONNECTION_HOLD'
  | 'RECOVERY_CANCEL'
  | 'RECOVERY_SPARE'
  | 'RECOVERY_HOLD'
  | 'RECOVERY_CREW'

export interface CauseLink {
  code: CauseCode
  minutes: number
  label: string
  detail: string
  flightId?: string
  sourceFlightId?: string
  closureId?: string
  actionId?: string
}

export type FlightStatus = 'ON_TIME' | 'DELAYED' | 'CANCELLED'
export type ConnectionStatus = 'MADE' | 'MISSED'

export interface FlightResult {
  id: string
  tailId: string
  scheduledDeparture: Minutes
  scheduledArrival: Minutes
  actualDeparture: Minutes | null
  actualArrival: Minutes | null
  delayMinutes: number
  status: FlightStatus
  causeChain: CauseLink[]
  rootCauseId: string | null
  rootCauseLabel: string | null
  crewId: string | null
  notes: string[]
}

export interface ConnectionResult {
  id: string
  airport: string
  fromFlightId: string
  toFlightId: string
  passengers: number
  minConnectMinutes: Minutes
  status: ConnectionStatus
  missedByMinutes: number
  strandedPassengers: number
  causeCode: CauseCode | null
}

export interface CrewResult {
  id: string
  tailId: string
  base: string
  dutyStart: Minutes
  dutyEnd: Minutes | null
  dutyMinutes: number
  maxDutyMinutes: number
  violation: boolean
  timedOutFlightIds: string[]
  assignedFlightIds: string[]
}

export interface AirportLoad {
  airportId: string
  departures: number
  arrivals: number
  delayedDepartures: number
  delayedArrivals: number
}

export interface SimulationKpis {
  totalFlights: number
  onTimeFlights: number
  delayedFlights: number
  cancelledFlights: number
  totalDelayMinutes: number
  delayedPassengers: number
  strandedPassengers: number
  strandedTransferPassengers: number
  missedConnections: number
  crewViolations: number
  worstDelayMinutes: number
  costScore: number
}

export interface PatientZero {
  id: string
  label: string
  kind: 'closure' | 'flight' | 'crew'
  affectedFlights: number
  downstreamDelayMinutes: number
  strandedPassengers: number
}

export interface AirportClosure {
  id: string
  airportId: string
  start: Minutes
  end: Minutes
  label?: string
}

export type RecoveryAction =
  | {
      id: string
      type: 'CANCEL_FLIGHT'
      flightId: string
      cost: number
    }
  | {
      id: string
      type: 'ACTIVATE_SPARE'
      spareId: string
      rotationTailId: string
      cost: number
    }
  | {
      id: string
      type: 'SWAP_AIRCRAFT'
      tailIdA: string
      tailIdB: string
      cost: number
    }
  | {
      id: string
      type: 'HOLD_FLIGHT'
      flightId: string
      holdMinutes: number
      cost: number
    }
  | {
      id: string
      type: 'REASSIGN_CREW'
      crewId: string
      flightId: string
      cost: number
    }

export interface ActionValidation {
  actionId: string
  valid: boolean
  reason: string
}

export interface SimulationInput {
  dataset: NormalizedDataset
  closures: AirportClosure[]
  actions?: RecoveryAction[]
  cancellationThresholdMinutes?: number
  minTurnaroundMinutes?: number
}

export interface SimulationOutput {
  flights: FlightResult[]
  flightById: Record<string, FlightResult>
  connections: ConnectionResult[]
  crews: CrewResult[]
  airports: AirportLoad[]
  kpis: SimulationKpis
  patientZeros: PatientZero[]
  actionValidation: ActionValidation[]
  closureImpact: Record<string, { downstreamDelayMinutes: number; strandedPassengers: number; affectedFlights: number }>
}

export interface RecoveryWeights {
  delayMinute: number
  cancellation: number
  strandedPassenger: number
  crewViolation: number
  actionCost: number
}

export interface CandidateEvaluation {
  action: RecoveryAction
  valid: boolean
  invalidReason?: string
  before: SimulationKpis
  after: SimulationKpis
  delta: {
    totalDelayMinutes: number
    cancellations: number
    strandedPassengers: number
    crewViolations: number
    costScore: number
  }
  rank: number
  rationale: string[]
}

export interface RecoverySearchResult {
  baseline: SimulationOutput
  candidates: CandidateEvaluation[]
  pairs: CandidateEvaluation[]
  unavailableOptions: Array<{ action: RecoveryAction; reason: string }>
}

export interface AiDispatchRequest {
  baseline: SimulationOutput
  candidates: CandidateEvaluation[]
  pairs: CandidateEvaluation[]
  weights: RecoveryWeights
}

export interface AiChosenAction {
  actionId: string
  action: RecoveryAction
}

export interface AiDispatchResponse {
  chosenActions: AiChosenAction[]
  reasoning: string
  citedNumbers: number[]
}
