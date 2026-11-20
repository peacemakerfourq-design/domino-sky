export type NumericClaimKind = 'number' | 'percentage' | 'time' | 'identifier'

export interface NumericClaim {
  raw: string
  value: number
  kind: NumericClaimKind
  source: string
  verified: boolean
  start: number
  end: number
}

export interface ValidatedSentence {
  text: string
  valid: boolean
  claims: NumericClaim[]
}

export interface ValidationReport {
  valid: boolean
  verifiedCount: number
  totalCount: number
  sentences: ValidatedSentence[]
  warnings: string[]
}

interface Fact {
  value: number
  source: string
  kind: NumericClaimKind
}

const TOKEN_PATTERN = /[A-Z]{2}\d{2,}|(?:[01]?\d|2[0-3]|24):[0-5]\d|-?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|-?\d+(?:\.\d+)?%?/gi

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function identifierValue(raw: string): number {
  const digits = raw.match(/\d+/g)?.join('') ?? ''
  return Number(digits)
}

function timeValue(raw: string): number {
  const [hoursText, minutesText] = raw.split(':')
  const hours = Number(hoursText)
  const minutes = Number(minutesText)
  return hours * 60 + minutes
}

function numericValue(raw: string): number {
  return Number(raw.replaceAll(',', '').replace('%', ''))
}

function factKey(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function collectFacts(payload: unknown): Map<string, Fact[]> {
  const facts = new Map<string, Fact[]>()

  const add = (value: number, source: string, kind: NumericClaimKind) => {
    if (!Number.isFinite(value)) return
    const key = factKey(value)
    const list = facts.get(key) ?? []
    list.push({ value, source, kind })
    facts.set(key, list)
  }

  const visit = (value: unknown, path: string) => {
    if (typeof value === 'number') {
      add(value, path || 'engine value', 'number')
      return
    }
    if (typeof value === 'string') {
      const identifierMatch = value.match(/^[A-Z]{2}\d{2,}$/)
      if (identifierMatch) {
        add(identifierValue(value), `${path} (${value})`, 'identifier')
      }
      const timeMatch = value.match(/^(?:[01]?\d|2[0-3]|24):[0-5]\d$/)
      if (timeMatch) {
        add(timeValue(value), `${path} (${value})`, 'time')
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (isPlainObject(value)) {
      Object.entries(value).forEach(([key, item]) => visit(item, path ? `${path}.${key}` : key))
    }
  }

  visit(payload, '')
  return facts
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .filter(Boolean)
}

function classifyClaim(raw: string): { value: number; kind: NumericClaimKind } {
  if (/^[A-Z]{2}\d{2,}$/i.test(raw)) {
    return { value: identifierValue(raw), kind: 'identifier' }
  }
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    return { value: timeValue(raw), kind: 'time' }
  }
  if (raw.endsWith('%')) {
    return { value: numericValue(raw), kind: 'percentage' }
  }
  return { value: numericValue(raw), kind: 'number' }
}

export function validateNarrative(text: string, enginePayload: unknown): ValidationReport {
  const facts = collectFacts(enginePayload)
  const sentences = splitSentences(text).map((sentenceText) => {
    const claims: NumericClaim[] = []
    const pattern = new RegExp(TOKEN_PATTERN.source, 'gi')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(sentenceText)) !== null) {
      const raw = match[0]
      const { value, kind } = classifyClaim(raw)
      const candidates = facts.get(factKey(value)) ?? []
      const exact = candidates.find((candidate) => candidate.kind === kind) ?? candidates[0]
      claims.push({
        raw,
        value,
        kind,
        source: exact?.source ?? 'No matching engine value',
        verified: Boolean(exact),
        start: match.index,
        end: match.index + raw.length,
      })
    }
    const invalid = claims.filter((claim) => !claim.verified)
    return {
      text: sentenceText,
      valid: invalid.length === 0,
      claims,
    }
  })

  const allClaims = sentences.flatMap((sentence) => sentence.claims)
  const invalid = allClaims.filter((claim) => !claim.verified)
  const warnings = invalid.map(
    (claim) => `Unsupported numeric claim “${claim.raw}” (${claim.value}).`,
  )

  return {
    valid: invalid.length === 0,
    verifiedCount: allClaims.length - invalid.length,
    totalCount: allClaims.length,
    sentences,
    warnings,
  }
}

export function injectWrongNumber(text: string): string {
  const pattern = /(?<![\w:])(-?\d+(?:\.\d+)?)(?![\w:])/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const original = Number(match[1])
    const replacement = original + 1
    return `${text.slice(0, match.index)}${replacement}${text.slice(match.index + match[1].length)}`
  }
  return `${text.trim()} 999999999.`
}

function readNumber(payload: unknown, path: string): number | null {
  const segments = path.split('.')
  let current: unknown = payload
  for (const segment of segments) {
    if (!isPlainObject(current)) return null
    current = current[segment]
  }
  return typeof current === 'number' ? current : null
}

export function generateTemplateNarrative(payload: unknown): string {
  const baselineDelay = readNumber(payload, 'baseline.kpis.totalDelayMinutes')
  const baselineStranded = readNumber(payload, 'baseline.kpis.strandedPassengers')
  const baselineCancellations = readNumber(payload, 'baseline.kpis.cancelledFlights')
  const baselineCrew = readNumber(payload, 'baseline.kpis.crewViolations')
  const candidates = isPlainObject(payload) && Array.isArray(payload.candidates) ? payload.candidates : []

  if (candidates.length === 0) {
    return `The engine found no ranked recovery candidate. The baseline has ${baselineDelay ?? 0} total delay minutes, ${baselineCancellations ?? 0} cancellations, ${baselineStranded ?? 0} stranded passengers, and ${baselineCrew ?? 0} crew violations.`
  }

  const first = candidates[0]
  if (!isPlainObject(first)) {
    return `The engine baseline has ${baselineDelay ?? 0} total delay minutes and ${baselineStranded ?? 0} stranded passengers.`
  }
  const action = isPlainObject(first.action) ? first.action : {}
  const after = isPlainObject(first.after) ? first.after : {}
  const afterKpis = isPlainObject(after.kpis) ? after.kpis : {}
  const actionId = typeof action.id === 'string' ? action.id : 'the top candidate'
  const afterDelay = typeof afterKpis.totalDelayMinutes === 'number'
    ? afterKpis.totalDelayMinutes
    : baselineDelay ?? 0
  const afterStranded = typeof afterKpis.strandedPassengers === 'number'
    ? afterKpis.strandedPassengers
    : baselineStranded ?? 0

  return `The dispatcher recommends ${actionId}. The engine projects ${afterDelay} total delay minutes and ${afterStranded} stranded passengers after this action, compared with a baseline of ${baselineDelay ?? 0} total delay minutes and ${baselineStranded ?? 0} stranded passengers.`
}

export function validateAiResponse(
  response: { reasoning: string; chosenActions?: Array<{ actionId: string }> },
  enginePayload: unknown,
): ValidationReport {
  const report = validateNarrative(response.reasoning, enginePayload)
  const candidates = isPlainObject(enginePayload) && Array.isArray(enginePayload.candidates)
    ? enginePayload.candidates
    : []
  const pairs = isPlainObject(enginePayload) && Array.isArray(enginePayload.pairs)
    ? enginePayload.pairs
    : []
  const validIds = new Set<string>()
  for (const candidate of [...candidates, ...pairs]) {
    if (!isPlainObject(candidate)) continue
    const action = isPlainObject(candidate.action) ? candidate.action : null
    if (action && typeof action.id === 'string') validIds.add(action.id)
  }

  const unknownActions = (response.chosenActions ?? []).filter(
    (chosen) => !validIds.has(chosen.actionId),
  )
  if (unknownActions.length > 0) {
    report.valid = false
    report.warnings.push(
      ...unknownActions.map(
        (chosen) => `AI selected an unknown action: ${chosen.actionId}.`,
      ),
    )
  }
  return report
}
