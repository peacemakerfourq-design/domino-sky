import type {
  AiDispatchRequest,
  AiDispatchResponse,
} from '../domain/types'
import { generateTemplateNarrative } from '../validator'

export function buildFallbackDispatch(request: AiDispatchRequest): AiDispatchResponse {
  const candidate = request.candidates[0] ?? request.pairs[0]
  const reasoning = generateTemplateNarrative(request)
  return {
    chosenActions: candidate
      ? [{ actionId: candidate.action.id, action: candidate.action }]
      : [],
    reasoning,
    citedNumbers: [
      request.baseline.kpis.totalDelayMinutes,
      request.baseline.kpis.strandedPassengers,
    ],
  }
}
