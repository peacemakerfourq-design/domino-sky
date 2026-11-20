import type {
  CandidateEvaluation,
  Flight,
  RecoveryAction,
  RecoverySearchResult,
  RecoveryWeights,
  SimulationInput,
  SimulationKpis,
} from '../domain/types'
import {
  DEFAULT_RECOVERY_WEIGHTS,
  RECOVERY_ACTION_BASE_COSTS,
  RECOVERY_SEARCH_LIMITS,
  compareText,
} from './constants'
import { simulateSimulation } from './simulation'

export { DEFAULT_RECOVERY_WEIGHTS } from './constants'

/** Runtime extension used to expose both members of a pair unambiguously. */
export interface RecoveryPairEvaluation extends CandidateEvaluation {
  pairedActions: [RecoveryAction, RecoveryAction]
}

/** Richer result type; it remains assignable to the shared domain result. */
export interface DetailedRecoverySearchResult extends RecoverySearchResult {
  pairs: RecoveryPairEvaluation[]
}

interface ScoredCandidate {
  evaluation: CandidateEvaluation
  objective: number
}

interface GeneratedOption {
  action: RecoveryAction
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => compareText(a, b))
}

function objectiveScore(
  kpis: SimulationKpis,
  actions: RecoveryAction[],
  weights: RecoveryWeights,
): number {
  const actionCost = actions.reduce((total, action) => total + action.cost, 0)
  return weights.delayMinute * kpis.totalDelayMinutes
    + weights.cancellation * kpis.cancelledFlights
    + weights.strandedPassenger * kpis.strandedPassengers
    + weights.crewViolation * kpis.crewViolations
    + weights.actionCost * actionCost
}

function scoreFormula(weights: RecoveryWeights): string {
  return `Score = ${weights.delayMinute} * delay minutes + ${weights.cancellation} * cancellations + ${weights.strandedPassenger} * stranded passengers + ${weights.crewViolation} * crew violations + ${weights.actionCost} * action cost; lower is better.`
}

function rotationBase(
  input: SimulationInput,
  rotationFlights: Flight[],
): string {
  const flightIds = new Set(rotationFlights.map((flight) => flight.id))
  const assignedCrew = input.dataset.crews.find((crew) =>
    crew.flightIds.some((flightId) => flightIds.has(flightId)),
  )
  return assignedCrew?.base ?? rotationFlights[0]?.origin ?? ''
}

function cancellationAction(flightId: string): RecoveryAction {
  return {
    id: `cancel:${flightId}`,
    type: 'CANCEL_FLIGHT',
    flightId,
    cost: RECOVERY_ACTION_BASE_COSTS.CANCEL_FLIGHT,
  }
}

function spareAction(spareId: string, rotationTailId: string): RecoveryAction {
  return {
    id: `spare:${spareId}:${rotationTailId}`,
    type: 'ACTIVATE_SPARE',
    spareId,
    rotationTailId,
    cost: RECOVERY_ACTION_BASE_COSTS.ACTIVATE_SPARE,
  }
}

function swapAction(tailIdA: string, tailIdB: string): RecoveryAction {
  const [tailA, tailB] = [tailIdA, tailIdB].sort((a, b) => compareText(a, b))
  return {
    id: `swap:${tailA}:${tailB}`,
    type: 'SWAP_AIRCRAFT',
    tailIdA: tailA,
    tailIdB: tailB,
    cost: RECOVERY_ACTION_BASE_COSTS.SWAP_AIRCRAFT,
  }
}

function holdAction(
  flightId: string,
  holdMinutes: number,
  connectionId?: string,
): RecoveryAction {
  return {
    id: connectionId
      ? `hold:${flightId}:${connectionId}`
      : `hold:${flightId}:${holdMinutes}`,
    type: 'HOLD_FLIGHT',
    flightId,
    holdMinutes,
    cost: RECOVERY_ACTION_BASE_COSTS.HOLD_FLIGHT_PER_MINUTE * holdMinutes,
  }
}

function crewAction(crewId: string, flightId: string): RecoveryAction {
  return {
    id: `crew:${crewId}:${flightId}`,
    type: 'REASSIGN_CREW',
    crewId,
    flightId,
    cost: RECOVERY_ACTION_BASE_COSTS.REASSIGN_CREW,
  }
}

function generateOptions(
  input: SimulationInput,
  baseline: ReturnType<typeof simulateSimulation>,
): { options: GeneratedOption[]; unavailable: Array<{ action: RecoveryAction; reason: string }> } {
  const dataset = input.dataset
  const flightById = new Map(dataset.flights.map((flight) => [flight.id, flight]))
  const rotations = new Map<string, Flight[]>()
  for (const flight of dataset.flights) {
    const flights = rotations.get(flight.tailId) ?? []
    flights.push(flight)
    rotations.set(flight.tailId, flights)
  }
  for (const flights of rotations.values()) {
    flights.sort((a, b) => a.legOrder - b.legOrder || a.departure - b.departure || compareText(a.id, b.id))
  }

  const disruptedFlightIds = baseline.flights
    .filter((flight) => flight.status !== 'ON_TIME')
    .map((flight) => flight.id)
  const impactedTailIds = new Set(
    disruptedFlightIds
      .map((flightId) => flightById.get(flightId)?.tailId)
      .filter((tailId): tailId is string => Boolean(tailId)),
  )
  const options: GeneratedOption[] = []
  const unavailable: Array<{ action: RecoveryAction; reason: string }> = []

  for (const flightId of disruptedFlightIds) {
    options.push({ action: cancellationAction(flightId) })
  }

  // A spare is feasible only from the rotation's operating base, before its
  // first departure, and with enough seats for every leg in the rotation.
  for (const tailId of uniqueSorted(impactedTailIds)) {
    const rotationFlights = rotations.get(tailId)
    if (!rotationFlights || rotationFlights.length === 0) continue
    const base = rotationBase(input, rotationFlights)
    const firstDeparture = Math.min(...rotationFlights.map((flight) => flight.departure))
    const requiredSeats = Math.max(...rotationFlights.map((flight) => flight.passengers))
    for (const spare of dataset.spares) {
      const action = spareAction(spare.id, tailId)
      if (spare.base !== base) {
        unavailable.push({
          action,
          reason: `Spare "${spare.id}" is based at ${spare.base}; rotation requires base ${base}.`,
        })
      } else if (spare.availableFrom > firstDeparture) {
        unavailable.push({
          action,
          reason: `Spare "${spare.id}" is unavailable until ${spare.availableFrom}; rotation starts at ${firstDeparture}.`,
        })
      } else if (spare.seats < requiredSeats) {
        unavailable.push({
          action,
          reason: `Spare "${spare.id}" has ${spare.seats} seats; rotation requires ${requiredSeats}.`,
        })
      } else {
        options.push({ action })
      }
    }
  }

  // Holding the onward flight by the exact shortfall can restore a missed
  // connection. A hold on the feeder would only reduce the available gap.
  for (const connection of baseline.connections) {
    if (connection.status !== 'MISSED') continue
    const feeder = baseline.flightById[connection.fromFlightId]
    const onward = baseline.flightById[connection.toFlightId]
    const action = holdAction(connection.toFlightId, connection.missedByMinutes, connection.id)
    if (feeder.status === 'CANCELLED' || onward.status === 'CANCELLED') {
      unavailable.push({
        action,
        reason: 'A cancelled flight cannot be restored by a hold.',
      })
    } else if (connection.missedByMinutes <= 0) {
      unavailable.push({
        action,
        reason: 'The connection has no finite timing shortfall to recover.',
      })
    } else {
      options.push({ action })
    }
  }

  // Crew relief candidates use the replacement crew id. The original crew is
  // inferred from the flight and skips only that flight during simulation.
  const originalCrewByFlightId = new Map<string, string>()
  for (const crew of dataset.crews) {
    for (const flightId of crew.flightIds) {
      if (!originalCrewByFlightId.has(flightId)) originalCrewByFlightId.set(flightId, crew.id)
    }
  }
  for (const crew of baseline.crews) {
    for (const timedOutFlightId of crew.timedOutFlightIds) {
      const originalCrewId = originalCrewByFlightId.get(timedOutFlightId)
      if (!originalCrewId) continue
      for (const replacement of dataset.crews) {
        if (replacement.id === originalCrewId) continue
        const targetFlight = flightById.get(timedOutFlightId)
        const replacementDutyLimit = replacement.dutyStart + replacement.maxDutyMinutes
        if (targetFlight && targetFlight.arrival > replacementDutyLimit) {
          unavailable.push({
            action: crewAction(replacement.id, timedOutFlightId),
            reason: `Crew "${replacement.id}" cannot cover ${timedOutFlightId} before its duty limit ${replacementDutyLimit}.`,
          })
          continue
        }
        options.push({ action: crewAction(replacement.id, timedOutFlightId) })
      }
    }
  }

  // Swaps are between complete nominal rotations. At least one side must be
  // disrupted; the other side may be a stable rotation.
  const rotationTailIds = uniqueSorted(rotations.keys())
  for (let a = 0; a < rotationTailIds.length; a += 1) {
    for (let b = a + 1; b < rotationTailIds.length; b += 1) {
      const tailA = rotationTailIds[a]
      const tailB = rotationTailIds[b]
      if (!impactedTailIds.has(tailA) && !impactedTailIds.has(tailB)) continue
      options.push({ action: swapAction(tailA, tailB) })
    }
  }

  return { options, unavailable }
}

function evaluationForAction(
  input: SimulationInput,
  baseline: ReturnType<typeof simulateSimulation>,
  action: RecoveryAction,
  weights: RecoveryWeights,
): { evaluation?: CandidateEvaluation; objective?: number; invalidReason?: string } {
  const afterOutput = simulateSimulation({ ...input, actions: [action] })
  const validation = afterOutput.actionValidation.find((item) => item.actionId === action.id)
  if (!validation?.valid) {
    return {
      invalidReason: validation?.reason ?? `Action "${action.id}" could not be validated.`,
    }
  }

  const beforeScore = objectiveScore(baseline.kpis, [], weights)
  const afterScore = objectiveScore(afterOutput.kpis, [action], weights)
  const evaluation: CandidateEvaluation = {
    action,
    valid: true,
    before: { ...baseline.kpis },
    after: { ...afterOutput.kpis },
    delta: {
      totalDelayMinutes: afterOutput.kpis.totalDelayMinutes - baseline.kpis.totalDelayMinutes,
      cancellations: afterOutput.kpis.cancelledFlights - baseline.kpis.cancelledFlights,
      strandedPassengers: afterOutput.kpis.strandedPassengers - baseline.kpis.strandedPassengers,
      crewViolations: afterOutput.kpis.crewViolations - baseline.kpis.crewViolations,
      costScore: afterScore - beforeScore,
    },
    rank: 0,
    rationale: [
      scoreFormula(weights),
      `Weighted objective ${afterScore} (baseline ${beforeScore}); lower is better.`,
      `Delay ${afterOutput.kpis.totalDelayMinutes - baseline.kpis.totalDelayMinutes} minutes; cancellations ${afterOutput.kpis.cancelledFlights - baseline.kpis.cancelledFlights}; stranded passengers ${afterOutput.kpis.strandedPassengers - baseline.kpis.strandedPassengers}; crew violations ${afterOutput.kpis.crewViolations - baseline.kpis.crewViolations}.`,
      `Action cost ${action.cost}.`,
    ],
  }
  return { evaluation, objective: afterScore }
}

function actionFlightIds(action: RecoveryAction): string[] {
  switch (action.type) {
    case 'CANCEL_FLIGHT':
    case 'HOLD_FLIGHT':
    case 'REASSIGN_CREW':
      return [action.flightId]
    case 'ACTIVATE_SPARE':
      return []
    case 'SWAP_AIRCRAFT':
      return []
  }
}

function actionTailIds(action: RecoveryAction): string[] {
  switch (action.type) {
    case 'ACTIVATE_SPARE':
      return [action.rotationTailId]
    case 'SWAP_AIRCRAFT':
      return [action.tailIdA, action.tailIdB]
    case 'CANCEL_FLIGHT':
    case 'HOLD_FLIGHT':
    case 'REASSIGN_CREW':
      return []
  }
}

function actionsConflict(
  first: RecoveryAction,
  second: RecoveryAction,
  input: SimulationInput,
): boolean {
  if (first.id === second.id) return true
  const firstFlights = new Set(actionFlightIds(first))
  const secondFlights = new Set(actionFlightIds(second))
  if (
    first.type === 'ACTIVATE_SPARE'
    && second.type === 'ACTIVATE_SPARE'
    && first.spareId === second.spareId
  ) {
    return true
  }
  for (const flightId of firstFlights) {
    if (secondFlights.has(flightId)) return true
  }

  const flightTail = new Map(input.dataset.flights.map((flight) => [flight.id, flight.tailId]))
  const firstTails = new Set(actionTailIds(first))
  const secondTails = new Set(actionTailIds(second))
  for (const tailId of firstTails) {
    if (secondTails.has(tailId)) return true
  }
  for (const flightId of firstFlights) {
    const tailId = flightTail.get(flightId)
    if (tailId && secondTails.has(tailId)) return true
  }
  for (const flightId of secondFlights) {
    const tailId = flightTail.get(flightId)
    if (tailId && firstTails.has(tailId)) return true
  }
  return false
}

function evaluatePairs(
  input: SimulationInput,
  baseline: ReturnType<typeof simulateSimulation>,
  scoredCandidates: ScoredCandidate[],
  weights: RecoveryWeights,
): RecoveryPairEvaluation[] {
  const source = scoredCandidates.slice(0, RECOVERY_SEARCH_LIMITS.maxPairSourceCandidates)
  const pairs: Array<{ evaluation: RecoveryPairEvaluation; objective: number }> = []

  for (let firstIndex = 0; firstIndex < source.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < source.length; secondIndex += 1) {
      const first = source[firstIndex].evaluation.action
      const second = source[secondIndex].evaluation.action
      if (actionsConflict(first, second, input)) continue
      const actions = [first, second]
      const afterOutput = simulateSimulation({ ...input, actions })
      const validations = afterOutput.actionValidation
      if (validations.some((validation) => !validation.valid)) continue

      const beforeScore = objectiveScore(baseline.kpis, [], weights)
      const afterScore = objectiveScore(afterOutput.kpis, actions, weights)
      const evaluation: RecoveryPairEvaluation = {
        action: first,
        pairedActions: [first, second],
        valid: true,
        before: { ...baseline.kpis },
        after: { ...afterOutput.kpis },
        delta: {
          totalDelayMinutes: afterOutput.kpis.totalDelayMinutes - baseline.kpis.totalDelayMinutes,
          cancellations: afterOutput.kpis.cancelledFlights - baseline.kpis.cancelledFlights,
          strandedPassengers: afterOutput.kpis.strandedPassengers - baseline.kpis.strandedPassengers,
          crewViolations: afterOutput.kpis.crewViolations - baseline.kpis.crewViolations,
          costScore: afterScore - beforeScore,
        },
        rank: 0,
        rationale: [
          `Pair: ${first.id} + ${second.id}.`,
          scoreFormula(weights),
          `Weighted objective ${afterScore} (baseline ${beforeScore}); lower is better.`,
          `Delay ${afterOutput.kpis.totalDelayMinutes - baseline.kpis.totalDelayMinutes} minutes; cancellations ${afterOutput.kpis.cancelledFlights - baseline.kpis.cancelledFlights}; stranded passengers ${afterOutput.kpis.strandedPassengers - baseline.kpis.strandedPassengers}; crew violations ${afterOutput.kpis.crewViolations - baseline.kpis.crewViolations}.`,
          `Combined action cost ${first.cost + second.cost}.`,
        ],
      }
      pairs.push({ evaluation, objective: afterScore })
    }
  }

  pairs.sort((a, b) =>
    a.objective - b.objective
    || compareText(a.evaluation.pairedActions[0].id, b.evaluation.pairedActions[0].id)
    || compareText(a.evaluation.pairedActions[1].id, b.evaluation.pairedActions[1].id),
  )
  return pairs
    .slice(0, RECOVERY_SEARCH_LIMITS.maxPairCandidates)
    .map((pair, index) => ({ ...pair.evaluation, rank: index + 1 }))
}

/**
 * Generate and evaluate deterministic recovery options.
 *
 * The baseline intentionally excludes recovery actions: every candidate and
 * pair is compared with the same no-recovery simulation.
 */
export function generateRecoveryCandidates(
  input: SimulationInput,
  weights: RecoveryWeights = DEFAULT_RECOVERY_WEIGHTS,
): DetailedRecoverySearchResult {
  const baseline = simulateSimulation({ ...input, actions: [] })
  const { options, unavailable } = generateOptions(input, baseline)
  const scored: ScoredCandidate[] = []
  const unavailableById = new Map(unavailable.map((item) => [item.action.id, item]))

  for (const option of options) {
    if (unavailableById.has(option.action.id)) continue
    const result = evaluationForAction(input, baseline, option.action, weights)
    if (!result.evaluation || result.objective === undefined) {
      unavailableById.set(option.action.id, {
        action: option.action,
        reason: result.invalidReason ?? `Action "${option.action.id}" is unavailable.`,
      })
      continue
    }
    scored.push({ evaluation: result.evaluation, objective: result.objective })
  }

  scored.sort((a, b) =>
    a.objective - b.objective || compareText(a.evaluation.action.id, b.evaluation.action.id),
  )
  const candidates = scored
    .slice(0, RECOVERY_SEARCH_LIMITS.maxSingleCandidates)
    .map((candidate, index) => ({ ...candidate.evaluation, rank: index + 1 }))
  const pairs = evaluatePairs(input, baseline, scored, weights)

  return {
    baseline,
    candidates,
    pairs,
    unavailableOptions: [...unavailableById.values()].sort((a, b) =>
      compareText(a.action.id, b.action.id),
    ),
  }
}

/** Search alias retained for callers that use the operational search name. */
export function searchRecoveryOptions(
  input: SimulationInput,
  weights: RecoveryWeights = DEFAULT_RECOVERY_WEIGHTS,
): DetailedRecoverySearchResult {
  return generateRecoveryCandidates(input, weights)
}
