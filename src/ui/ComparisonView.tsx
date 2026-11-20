import type {
  Airport,
  Aircraft,
  AirportClosure,
  Flight,
  SimulationOutput,
} from '../domain/types'
import { NetworkMap } from './NetworkMap'
import { GanttView } from './GanttView'

interface ComparisonViewProps {
  airports: Airport[]
  aircraft: Aircraft[]
  flights: Flight[]
  closures: AirportClosure[]
  before: SimulationOutput
  after: SimulationOutput
  selectedFlightId: string | null
  scrubTime: number
  onSelectFlight: (flightId: string) => void
}

export function ComparisonView({
  airports,
  aircraft,
  flights,
  closures,
  before,
  after,
  selectedFlightId,
  scrubTime,
  onSelectFlight,
}: ComparisonViewProps) {
  return (
    <section className="panel comparison-panel">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-icon">↔</span>
          <div>
            <h2>Recovery comparison</h2>
            <p className="panel-subtitle">The same incident, map, and rotation model on both sides.</p>
          </div>
        </div>
      </div>
      <div className="comparison-grid">
        <div className="comparison-column">
          <h3>Before recovery</h3>
          <NetworkMap
            airports={airports}
            flights={flights}
            results={before.flights}
            closures={closures}
            selectedFlightId={selectedFlightId}
            scrubTime={scrubTime}
            onSelectFlight={onSelectFlight}
            compact
          />
          <GanttView
            aircraft={aircraft}
            flights={flights}
            results={before.flights}
            selectedFlightId={selectedFlightId}
            onSelectFlight={onSelectFlight}
            compact
          />
        </div>
        <div className="comparison-column">
          <h3>After recovery</h3>
          <NetworkMap
            airports={airports}
            flights={flights}
            results={after.flights}
            closures={closures}
            selectedFlightId={selectedFlightId}
            scrubTime={scrubTime}
            onSelectFlight={onSelectFlight}
            compact
          />
          <GanttView
            aircraft={aircraft}
            flights={flights}
            results={after.flights}
            selectedFlightId={selectedFlightId}
            onSelectFlight={onSelectFlight}
            compact
          />
        </div>
      </div>
    </section>
  )
}
