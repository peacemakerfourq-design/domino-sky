import type {
  AiDispatchRequest,
  AiDispatchResponse,
} from '../domain/types'

export interface AiTransportResult {
  response: AiDispatchResponse
  attempts: number
  transport: 'ai' | 'fallback'
  providerError?: string
}

function isAiDispatchResponse(value: unknown): value is AiDispatchResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AiDispatchResponse>
  return (
    Array.isArray(candidate.chosenActions) &&
    typeof candidate.reasoning === 'string' &&
    Array.isArray(candidate.citedNumbers)
  )
}

export async function callAiDispatcher(
  request: AiDispatchRequest,
  signal?: AbortSignal,
): Promise<AiDispatchResponse> {
  const response = await fetch('/api/dispatcher', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Dispatcher API returned ${response.status}: ${detail.slice(0, 180)}`)
  }

  const payload: unknown = await response.json()
  if (!isAiDispatchResponse(payload)) {
    throw new Error('Dispatcher API returned an invalid response shape')
  }
  return payload
}

export async function callAiWithRetries(
  request: AiDispatchRequest,
  maxRetries: number,
  validate: (response: AiDispatchResponse) => boolean,
  fallback: () => AiDispatchResponse,
  signal?: AbortSignal,
): Promise<AiTransportResult> {
  let lastError: string | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await callAiDispatcher(request, signal)
      if (validate(response)) {
        return { response, attempts: attempt + 1, transport: 'ai' }
      }
      lastError = 'AI response failed the Number Guard.'
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'AI request failed.'
    }
  }

  return {
    response: fallback(),
    attempts: maxRetries + 1,
    transport: 'fallback',
    providerError: lastError,
  }
}
