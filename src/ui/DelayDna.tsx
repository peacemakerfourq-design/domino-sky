import type { CSSProperties } from 'react'
import type {
  CauseCode,
  FlightResult,
  PatientZero,
} from '../domain/types'
import { causeLabel, formatDelay, formatTime } from './format'

interface DelayDnaProps {
  flight: FlightResult | null
  flightById: Record<string, FlightResult>
  patientZeros: PatientZero[]
  onSelectFlight: (flightId: string) => void
}

export const causeColors: Record<CauseCode, string> = {
  WEATHER_CLOSURE: '#ff6b6b',
  ROTATION_KNOCKON: '#f6b94a',
  CREW_TIMEOUT: '#d88cff',
  CREW_WAIT: '#9c7cff',
  CONNECTION_HOLD: '#4bb8ff',
  RECOVERY_CANCEL: '#ff8f5b',
  RECOVERY_SPARE: '#3ecf9a',
  RECOVERY_HOLD: '#55d6be',
  RECOVERY_CREW: '#c08cff',
}

function LineageNode({
  flight,
  flightById,
  onSelectFlight,
  depth = 0,
}: {
  flight: FlightResult
  flightById: Record<string, FlightResult>
  onSelectFlight: (flightId: string) => void
  depth?: number
}) {
  const sources = flight.causeChain
    .map((link) => link.sourceFlightId)
    .filter((id): id is string => Boolean(id))
    .filter((id, index, all) => all.indexOf(id) === index)

  return (
    <div className="lineage-node" style={{ '--lineage-depth': depth } as CSSProperties}>
      <div className="lineage-marker" />
      <div className="lineage-content">
        <button className="lineage-flight" onClick={() => onSelectFlight(flight.id)}>
          <strong>{flight.id}</strong>
          <span>{flight.tailId}</span>
        </button>
        <div className="lineage-meta">
          <span>{formatTime(flight.scheduledDeparture)} scheduled</span>
          <span className={flight.delayMinutes > 0 ? 'danger-text' : ''}>
            {formatDelay(flight.delayMinutes)}
          </span>
          <span className={`status-pill status-${flight.status.toLowerCase()}`}>
            {flight.status.toLowerCase()}
          </span>
        </div>
        {flight.causeChain.length === 0 ? (
          <p className="lineage-clean">No causal delay detected.</p>
        ) : (
          <div className="cause-chain">
            {flight.causeChain.map((link, index) => (
              <div
                className="cause-link"
                key={`${flight.id}-${link.code}-${link.sourceFlightId ?? index}`}
              >
                <span
                  className="cause-dot"
                  style={{ backgroundColor: causeColors[link.code] }}
                />
                <div>
                  <strong>{causeLabel(link.code)}</strong>
                  <span>{link.label}</span>
                  {link.detail && <small>{link.detail}</small>}
                </div>
                <b>{link.minutes}m</b>
              </div>
            ))}
          </div>
        )}
      </div>
      {sources.map((sourceId) => {
        const source = flightById[sourceId]
        return source ? (
          <LineageNode
            key={sourceId}
            flight={source}
            flightById={flightById}
            onSelectFlight={onSelectFlight}
            depth={depth + 1}
          />
        ) : null
      })}
    </div>
  )
}

export function DelayDna({
  flight,
  flightById,
  patientZeros,
  onSelectFlight,
}: DelayDnaProps) {
  return (
    <div className="delay-dna-layout">
      <section className="dna-trace-panel">
        {!flight ? (
          <div className="empty-state">
            <span className="empty-orbit" />
            <h3>Select a disrupted flight</h3>
            <p>Its complete causal lineage will appear here.</p>
          </div>
        ) : (
          <>
            <div className="dna-flight-head">
              <div>
                <span className="eyebrow">Delay DNA</span>
                <h3>{flight.id}</h3>
                <p>{flight.tailId} · {flight.notes.join(' · ') || 'Rotation lineage'}</p>
              </div>
              <strong className="dna-total">{formatDelay(flight.delayMinutes)}</strong>
            </div>
            <div className="dna-chain">
              <LineageNode
                flight={flight}
                flightById={flightById}
                onSelectFlight={onSelectFlight}
              />
            </div>
          </>
        )}
      </section>

      <section className="patient-zero-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Root-cause analysis</span>
            <h3>Patient zero ranking</h3>
          </div>
        </div>
        <p className="panel-subtitle">Ranked by total downstream minutes and stranded passengers.</p>
        <ol className="patient-list">
          {patientZeros.map((root, index) => (
            <li key={root.id}>
              <span className="patient-rank">{index + 1}</span>
              <div>
                <strong>{root.label}</strong>
                <small>{root.affectedFlights} downstream flights</small>
              </div>
              <div className="patient-impact">
                <b>{root.downstreamDelayMinutes}m</b>
                <small>{root.strandedPassengers} stranded</small>
              </div>
            </li>
          ))}
          {patientZeros.length === 0 && (
            <li className="patient-empty">No causal incident in this scenario.</li>
          )}
        </ol>
      </section>
    </div>
  )
}
