import { useMemo } from 'react'
import type {
  Airport,
  AirportClosure,
  Flight,
  FlightResult,
} from '../domain/types'
import { formatTime, replayStatus } from './format'

interface NetworkMapProps {
  airports: Airport[]
  flights: Flight[]
  results: FlightResult[]
  closures: AirportClosure[]
  selectedFlightId: string | null
  scrubTime: number
  onSelectFlight: (flightId: string) => void
  compact?: boolean
}

interface ProjectedPoint {
  x: number
  y: number
}

const VIEW_WIDTH = 760
const VIEW_HEIGHT = 430

function project(airport: Airport): ProjectedPoint {
  const x = 28 + ((airport.lng - 70) / 23) * (VIEW_WIDTH - 56)
  const y = 24 + ((32 - airport.lat) / 24) * (VIEW_HEIGHT - 48)
  return { x, y }
}

function routePath(from: ProjectedPoint, to: ProjectedPoint): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const lift = Math.min(70, 18 + distance * 0.16)
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2 - lift
  return `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`
}

function statusColor(status: ReturnType<typeof replayStatus>): string {
  switch (status) {
    case 'DELAY_PENDING':
      return '#f6b94a'
    case 'ACTIVE_DELAYED':
      return '#ff5f67'
    case 'CANCELLED':
      return '#697386'
    case 'PENDING':
      return '#3ecf9a'
    case 'ON_TIME':
      return '#3ecf9a'
  }
}

export function NetworkMap({
  airports,
  flights,
  results,
  closures,
  selectedFlightId,
  scrubTime,
  onSelectFlight,
  compact = false,
}: NetworkMapProps) {
  const points = useMemo(
    () => Object.fromEntries(airports.map((airport) => [airport.id, project(airport)])),
    [airports],
  )
  const resultById = useMemo(
    () => Object.fromEntries(results.map((result) => [result.id, result])),
    [results],
  )

  return (
    <div className={`network-map ${compact ? 'network-map--compact' : ''}`}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label="Schematic map of the Domino Sky flight network"
      >
        <defs>
          <filter id="map-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id="map-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <path d="M 28 0 L 0 0 0 28" fill="none" stroke="rgba(255,255,255,.035)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#map-grid)" rx="16" />

        {flights.map((flight) => {
          const from = points[flight.origin]
          const to = points[flight.destination]
          const result = resultById[flight.id]
          if (!from || !to || !result) return null
          const replay = replayStatus(result, scrubTime)
          const selected = selectedFlightId === flight.id
          const selectedTail = selectedFlightId
            ? resultById[selectedFlightId]?.tailId === flight.tailId
            : false
          return (
            <path
              key={flight.id}
              d={routePath(from, to)}
              fill="none"
              stroke={statusColor(replay)}
              strokeWidth={selected ? 3.2 : selectedTail ? 1.8 : 1.15}
              strokeOpacity={selected ? 1 : selectedTail ? 0.68 : 0.25}
              strokeDasharray={result.status === 'CANCELLED' ? '4 6' : undefined}
              className="flight-route"
              onClick={() => onSelectFlight(flight.id)}
            >
              <title>
                {`${flight.id} · ${flight.origin} → ${flight.destination} · ${result.status} · ${result.delayMinutes}m delay`}
              </title>
            </path>
          )
        })}

        {airports.map((airport) => {
          const point = points[airport.id]
          const activeClosure = closures.some(
            (closure) =>
              closure.airportId === airport.id &&
              scrubTime >= closure.start &&
              scrubTime < closure.end,
          )
          const selectedAirport = closures.some((closure) => closure.airportId === airport.id)
          return (
            <g
              key={airport.id}
              transform={`translate(${point.x} ${point.y})`}
              className="airport-node"
            >
              {activeClosure && <circle r="13" className="airport-closure-pulse" />}
              {selectedAirport && <circle r="9" className="airport-closure-ring" />}
              <circle r={airport.tier === 'mega_hub' ? 6.5 : 4.5} className="airport-dot" />
              <text x="9" y="-7" className="airport-code">
                {airport.id}
              </text>
              <text x="9" y="7" className="airport-city">
                {airport.city}
              </text>
              <title>{`${airport.name} · ${airport.capacityPerHour} movements/hour capacity`}</title>
            </g>
          )
        })}

        {!compact && (
          <g className="map-clock" transform={`translate(${VIEW_WIDTH - 112} 26)`}>
            <rect width="92" height="34" rx="8" />
            <text x="46" y="22" textAnchor="middle">
              {formatTime(scrubTime)}
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}
