import type { CrewResult } from '../domain/types'
import { formatTime } from './format'

interface CrewDutyPanelProps {
  crews: CrewResult[]
}

export function CrewDutyPanel({ crews }: CrewDutyPanelProps) {
  const sorted = [...crews].sort((a, b) => b.dutyMinutes - a.dutyMinutes)
  return (
    <div className="crew-list">
      {sorted.map((crew) => {
        const percent = Math.min(100, (crew.dutyMinutes / crew.maxDutyMinutes) * 100)
        const overflow = Math.max(0, crew.dutyMinutes - crew.maxDutyMinutes)
        return (
          <article className={`crew-row ${crew.violation ? 'crew-row--violation' : ''}`} key={crew.id}>
            <div className="crew-row-head">
              <div>
                <strong>{crew.id}</strong>
                <span>{crew.tailId}</span>
              </div>
              <div className="crew-duty-value">
                <strong>{crew.dutyMinutes}m</strong>
                <span>/ {crew.maxDutyMinutes}m</span>
              </div>
            </div>
            <div
              className="meter"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={crew.maxDutyMinutes}
              aria-valuenow={crew.dutyMinutes}
              aria-label={`${crew.id} duty minutes`}
            >
              <span
                className="meter-fill"
                style={{ width: `${percent}%` }}
              />
              <span className="meter-limit" />
            </div>
            <div className="crew-row-foot">
              <span>{formatTime(crew.dutyStart)} → {formatTime(crew.dutyEnd)}</span>
              {crew.violation ? (
                <span className="danger-text">+{overflow}m over limit</span>
              ) : (
                <span>{crew.maxDutyMinutes - crew.dutyMinutes}m remaining</span>
              )}
            </div>
            {crew.timedOutFlightIds.length > 0 && (
              <div className="crew-alert">
                Timed out: {crew.timedOutFlightIds.join(', ')}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}
