import { ShieldCheck, ShieldX } from 'lucide-react'

export interface GuardClaimView {
  raw: string
  value: number
  source: string
  verified: boolean
}

export interface GuardSentenceView {
  text: string
  valid: boolean
  claims: GuardClaimView[]
}

export interface GuardReportView {
  valid: boolean
  verifiedCount: number
  totalCount: number
  sentences: GuardSentenceView[]
  warnings: string[]
}

interface NumberGuardProps {
  report: GuardReportView | null
  tamperActive?: boolean
}

function renderSentence(sentence: GuardSentenceView) {
  if (!sentence.text) return null
  const claims = [...sentence.claims].sort(
    (a, b) => b.raw.length - a.raw.length,
  )
  const pattern = claims.length
    ? new RegExp(`(${claims.map((claim) => claim.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
    : /$^/g
  const parts = sentence.text.split(pattern)
  return parts.map((part, index) => {
    const claim = sentence.claims.find((item) => item.raw === part)
    if (!claim) return <span key={index}>{part}</span>
    return (
      <span
        className={`number-claim ${claim.verified ? '' : 'number-claim--invalid'}`}
        title={`${claim.verified ? 'Verified source' : 'Unsupported claim'}: ${claim.source}`}
        key={`${index}-${part}`}
      >
        {part}
      </span>
    )
  })
}

export function NumberGuard({ report, tamperActive = false }: NumberGuardProps) {
  if (!report) {
    return (
      <div className="guard-placeholder">
        The dispatcher’s numeric claims will be checked here before rendering.
      </div>
    )
  }

  const badgeClass = report.valid && !tamperActive
    ? 'number-guard-badge'
    : 'number-guard-badge number-guard-badge--error'

  return (
    <div className="number-guard">
      <div className={badgeClass} title="Each number is matched against the deterministic engine output">
        {report.valid && !tamperActive ? <ShieldCheck size={13} /> : <ShieldX size={13} />}
        {tamperActive
          ? 'Tamper detected — unsupported number blocked'
          : `Verified by engine: ${report.verifiedCount}/${report.totalCount} numbers`}
      </div>

      <div className="guard-sentences">
        {report.sentences.map((sentence, index) => (
          <div
            className={`guard-sentence ${sentence.valid ? '' : 'is-blocked'}`}
            key={`${index}-${sentence.text.slice(0, 12)}`}
          >
            {!sentence.valid ? (
              <span>⚠ Sentence blocked: {sentence.text}</span>
            ) : (
              renderSentence(sentence)
            )}
          </div>
        ))}
      </div>

      {tamperActive && (
        <div className="guard-warning">
          The tamper test intentionally changed one numeric claim. The guard found the unsupported
          value and blocked the affected sentence.
        </div>
      )}

      {report.warnings.map((warning) => (
        <div className="guard-warning" key={warning}>{warning}</div>
      ))}
    </div>
  )
}
