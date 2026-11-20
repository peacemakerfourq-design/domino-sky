import type { Aircraft, Flight, FlightResult } from '../domain/types'
import { formatTime } from './format'

interface GanttViewProps {
  aircraft: Aircraft[]
  flights: Flight[]
  results: FlightResult[]
  selectedFlightId: string | null
  onSelectFlight: (flightId: string) => void
  compact?: boolean
}

const DAY_MINUTES = 1440
const ROW_HEIGHT = 34
const CHART_WIDTH = 900
const LABEL_WIDTH = 118

function xForTime(minutes: number): number {
  return LABEL_WIDTH + (minutes / DAY_MINUTES) * (CHART_WIDTH - LABEL_WIDTH - 12)
}

export function GanttView({
  aircraft,
  flights,
  results,
  selectedFlightId,
  onSelectFlight,
  compact = false,
}: GanttViewProps) {
  const flightById = new Map(flights.map((flight) => [flight.id, flight]))
  const resultById = new Map(results.map((result) => [result.id, result]))
  const height = aircraft.length * ROW_HEIGHT + 34

  return (
    <div className="gantt-scroll">
      <svg
        className={`gantt-chart ${compact ? 'gantt-chart--compact' : ''}`}
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        width={CHART_WIDTH}
        height={height}
        role="img"
        aria-label="Gantt view of aircraft rotations and delay bars"
      >
        {Array.from({ length: 25 }, (_, hour) => {
          const x = xForTime(hour * 60)
          return (
            <g key={hour}>
              <line x1={x} x2={x} y1="22" y2={height - 8} className="gantt-grid" />
              <text x={x} y="14" textAnchor="middle" className="gantt-time">
                {String(hour).padStart(2, '0')}:00
              </text>
            </g>
          )
        })}

        {aircraft.map((plane, rowIndex) => {
          const y = 28 + rowIndex * ROW_HEIGHT
          return (
            <g key={plane.id}>
              <line x1="10" x2={CHART_WIDTH - 10} y1={y + 9} y2={y + 9} className="gantt-row-line" />
              <text x="12" y={y + 13} className="gantt-tail">
                {plane.id}
              </text>
              {plane.flightIds.map((flightId) => {
                const flight = flightById.get(flightId)
                const result = resultById.get(flightId)
                if (!flight || !result) return null
                const scheduledX = xForTime(flight.departure)
                const scheduledEndX = xForTime(flight.arrival)
                const actualStart = result.actualDeparture ?? flight.departure
                const actualEnd = result.actualArrival ?? flight.arrival
                const actualX = xForTime(actualStart)
                const actualEndX = xForTime(actualEnd)
                const selected = selectedFlightId === flight.id
                const statusClass = result.status.toLowerCase()
                return (
                  <g
                    key={flight.id}
                    className={`gantt-flight ${selected ? 'is-selected' : ''}`}
                    onClick={() => onSelectFlight(flight.id)}
                  >
                    <line
                      x1={scheduledX}
                      x2={scheduledEndX}
                      y1={y + 5}
                      y2={y + 5}
                      className="gantt-scheduled"
                    />
                    <rect
                      x={Math.min(scheduledX, actualX)}
                      y={y - 2}
                      width={Math.max(4, Math.abs(actualEndX - actualX))}
                      height={14}
                      rx="4"
                      className={`gantt-actual gantt-${statusClass}`}
                    />
                    {actualX > scheduledX && (
                      <rect
                        x={scheduledX}
                        y={y - 2}
                        width={Math.max(2, actualX - scheduledX)}
                        height={14}
                        rx="3"
                        className="gantt-delay"
                      />
                    )}
                    <text x={scheduledX + 3} y={y + 8} className="gantt-flight-id">
                      {flight.id}
                    </text>
                    <title>
                      {`${flight.id}: scheduled ${formatTime(flight.departure)}–${formatTime(flight.arrival)}, actual ${result.status.toLowerCase()}, delay ${result.delayMinutes}m`}
                    </title>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
