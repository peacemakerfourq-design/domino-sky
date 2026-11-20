import { useMemo, useState } from 'react'
import type { Flight, FlightResult } from '../domain/types'
import { formatDelay, formatTime } from './format'

interface FlightTableProps {
  flights: Flight[]
  results: FlightResult[]
  selectedFlightId: string | null
  onSelectFlight: (flightId: string) => void
  compact?: boolean
}

type SortKey = 'delay' | 'status' | 'cause' | 'scheduled'

const statusOrder = { CANCELLED: 3, DELAYED: 2, ON_TIME: 1 }

export function FlightTable({
  flights,
  results,
  selectedFlightId,
  onSelectFlight,
  compact = false,
}: FlightTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('delay')
  const [ascending, setAscending] = useState(false)
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    const resultById = new Map(results.map((result) => [result.id, result]))
    return flights
      .map((flight) => ({ flight, result: resultById.get(flight.id) }))
      .filter((row): row is { flight: Flight; result: FlightResult } => Boolean(row.result))
      .filter(({ flight, result }) => {
        const needle = query.trim().toLowerCase()
        if (!needle) return true
        return `${flight.id} ${flight.tailId} ${flight.origin} ${flight.destination} ${result.rootCauseLabel ?? ''}`
          .toLowerCase()
          .includes(needle)
      })
      .sort((a, b) => {
        let comparison = 0
        switch (sortKey) {
          case 'delay':
            comparison = a.result.delayMinutes - b.result.delayMinutes
            break
          case 'status':
            comparison = statusOrder[a.result.status] - statusOrder[b.result.status]
            break
          case 'cause':
            comparison = (a.result.rootCauseLabel ?? '').localeCompare(b.result.rootCauseLabel ?? '')
            break
          case 'scheduled':
            comparison = a.flight.departure - b.flight.departure
            break
        }
        return ascending ? comparison : -comparison
      })
  }, [flights, results, query, sortKey, ascending])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setAscending((value) => !value)
    else {
      setSortKey(key)
      setAscending(false)
    }
  }

  return (
    <div className="table-wrap">
      {!compact && (
        <div className="table-toolbar">
          <label className="search-field">
            <span className="sr-only">Search flights</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search flight, tail, route or cause…"
            />
          </label>
          <span className="table-count">{rows.length} legs</span>
        </div>
      )}
      <table className={`flight-table ${compact ? 'flight-table--compact' : ''}`}>
        <thead>
          <tr>
            <th>Flight</th>
            <th>Route</th>
            <th>
              <button onClick={() => toggleSort('scheduled')}>Scheduled</button>
            </th>
            <th>
              <button onClick={() => toggleSort('delay')}>Delay</button>
            </th>
            <th>
              <button onClick={() => toggleSort('status')}>Status</button>
            </th>
            <th>
              <button onClick={() => toggleSort('cause')}>Cause</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ flight, result }) => (
            <tr
              key={flight.id}
              className={selectedFlightId === flight.id ? 'is-selected' : ''}
              onClick={() => onSelectFlight(flight.id)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectFlight(flight.id)
              }}
            >
              <td>
                <strong>{flight.id}</strong>
                <small>{flight.tailId}</small>
              </td>
              <td className="route-cell">
                <span>{flight.origin}</span>
                <span className="route-arrow">→</span>
                <span>{flight.destination}</span>
              </td>
              <td>
                <span>{formatTime(flight.departure)}</span>
                <small>arr {formatTime(flight.arrival)}</small>
              </td>
              <td className={result.delayMinutes > 0 ? 'delay-positive' : ''}>
                {formatDelay(result.delayMinutes)}
              </td>
              <td>
                <span className={`status-pill status-${result.status.toLowerCase()}`}>
                  {result.status === 'ON_TIME' ? 'On time' : result.status.toLowerCase()}
                </span>
              </td>
              <td className="cause-cell">
                <span>{result.rootCauseLabel ?? '—'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
