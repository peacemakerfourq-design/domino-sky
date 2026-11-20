import type { RecoveryWeights } from '../domain/types'

/** Locale-independent text ordering for reproducible rankings. */
export function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** A flight is cancelled when its computed departure delay reaches this value. */
export const DEFAULT_CANCELLATION_THRESHOLD_MINUTES = 180

/**
 * Lower is better. These weights are deliberately modest and are also used to
 * produce the human-facing simulation cost score. Recovery searches may
 * replace them with caller supplied weights.
 */
export const DEFAULT_RECOVERY_WEIGHTS: Readonly<RecoveryWeights> = {
  delayMinute: 1,
  cancellation: 1_000,
  strandedPassenger: 10,
  crewViolation: 500,
  actionCost: 1,
}

/** Assumed operating cost when a recovery option is generated. */
export const RECOVERY_ACTION_BASE_COSTS = {
  CANCEL_FLIGHT: 500,
  ACTIVATE_SPARE: 1_500,
  SWAP_AIRCRAFT: 1_000,
  HOLD_FLIGHT_PER_MINUTE: 5,
  REASSIGN_CREW: 750,
} as const

/** Search limits keep the practical (single + pair) search responsive. */
export const RECOVERY_SEARCH_LIMITS = {
  maxSingleCandidates: 1_000,
  maxPairSourceCandidates: 30,
  maxPairCandidates: 10,
} as const

/** Ranking-only conversion; it is not a simulation KPI or recovery score. */
export const PATIENT_ZERO_RANKING = {
  strandedPassengerMinutes: 10,
  affectedFlightMinutes: 60,
} as const
