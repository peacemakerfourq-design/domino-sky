import type { DatasetLoadResult } from '../domain/types'

interface DataHealthPanelProps {
  health: DatasetLoadResult['health']
  onClose: () => void
}

export function DataHealthPanel({ health, onClose }: DataHealthPanelProps) {
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="health-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="health-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <span className="eyebrow">Validation report</span>
            <h2 id="health-title">Data health</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close data health panel">×</button>
        </div>

        <div className={`health-banner ${health.valid ? 'health-banner--ok' : 'health-banner--error'}`}>
          <strong>{health.valid ? 'Dataset accepted' : 'Dataset needs attention'}</strong>
          <span>{health.summary.errors} errors · {health.summary.warnings} warnings</span>
        </div>

        <div className="health-counts">
          {[
            ['Airports', health.summary.airports],
            ['Flights', health.summary.flights],
            ['Aircraft', health.summary.aircraft],
            ['Connections', health.summary.connections],
            ['Crews', health.summary.crews],
            ['Spares', health.summary.spares],
          ].map(([label, value]) => (
            <div key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>

        <div className="health-issues">
          {health.issues.length === 0 ? (
            <div className="empty-state empty-state--small">
              <h3>No issues found</h3>
              <p>The organiser dataset passed every structural check.</p>
            </div>
          ) : (
            health.issues.map((issue, index) => (
              <article className={`health-issue health-issue--${issue.severity}`} key={`${issue.code}-${index}`}>
                <span className="issue-dot" />
                <div>
                  <strong>{issue.code.replaceAll('_', ' ')}</strong>
                  <p>{issue.message}</p>
                  {issue.entityIds.length > 0 && <small>{issue.entityIds.join(', ')}</small>}
                </div>
              </article>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
