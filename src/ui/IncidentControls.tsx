import { useEffect, useState } from 'react'
import { CloudRain, Plus, RotateCcw, Trash2, Zap } from 'lucide-react'
import type { Airport, AirportClosure } from '../domain/types'
import { formatTime } from './format'

interface IncidentControlsProps {
  airports: Airport[]
  closures: AirportClosure[]
  thresholdMinutes: number
  onApply: (closures: AirportClosure[], thresholdMinutes: number) => void
  onDemo: () => void
  onDeepDemo: () => void
  onClear: () => void
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

export function IncidentControls({
  airports,
  closures,
  thresholdMinutes,
  onApply,
  onDemo,
  onDeepDemo,
  onClear,
}: IncidentControlsProps) {
  const [airportId, setAirportId] = useState('BOM')
  const [startTime, setStartTime] = useState('14:00')
  const [duration, setDuration] = useState(90)
  const [draft, setDraft] = useState<AirportClosure[]>(closures)
  const [threshold, setThreshold] = useState(thresholdMinutes)

  useEffect(() => {
    setDraft(closures)
    const first = closures[0]
    if (first) {
      setAirportId(first.airportId)
      setStartTime(formatTime(first.start))
      setDuration(Math.max(30, first.end - first.start))
    }
  }, [closures])

  const addClosure = () => {
    const start = timeToMinutes(startTime)
    const closure: AirportClosure = {
      id: `CL-${String(draft.length + 1).padStart(2, '0')}`,
      airportId,
      start,
      end: start + duration,
      label: `${airportId} closure`,
    }
    setDraft((current) => [...current, closure])
  }

  const apply = () => {
    onApply(draft, threshold)
  }

  return (
    <section className="incident-panel">
      <div className="incident-title">
        <div className="incident-icon"><CloudRain size={20} /></div>
        <div>
          <span className="eyebrow">Incident builder</span>
          <h2>Create disruption</h2>
        </div>
        <button className="demo-button" onClick={onDemo}>
          <Zap size={14} /> Mumbai storm
        </button>
      </div>

      <div className="incident-form">
        <label>
          <span>Airport</span>
          <select value={airportId} onChange={(event) => setAirportId(event.target.value)}>
            {airports.map((airport) => (
              <option value={airport.id} key={airport.id}>
                {airport.id} · {airport.city}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Closure start</span>
          <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
        </label>
      </div>

      <div className="duration-control">
        <div className="control-label">
          <span>Duration</span>
          <output>{duration} min</output>
        </div>
        <input
          type="range"
          min="30"
          max="240"
          step="15"
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
          aria-label="Closure duration in minutes"
        />
        <div className="preset-row">
          {[30, 90, 180].map((preset) => (
            <button
              className={duration === preset ? 'is-active' : ''}
              onClick={() => setDuration(preset)}
              key={preset}
            >
              {preset}m
            </button>
          ))}
        </div>
      </div>

      <div className="closure-list">
        {draft.length === 0 ? (
          <p className="closure-empty">No closures queued. The schedule is operating normally.</p>
        ) : (
          draft.map((closure) => (
            <div className="closure-chip" key={closure.id}>
              <span className="closure-status" />
              <div>
                <strong>{closure.airportId} closed</strong>
                <small>{formatTime(closure.start)}–{formatTime(closure.end)}</small>
              </div>
              <button
                onClick={() => setDraft((current) => current.filter((item) => item.id !== closure.id))}
                aria-label={`Remove ${closure.airportId} closure`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="threshold-control">
        <label htmlFor="cancel-threshold">
          Auto-cancel delay threshold
          <input
            id="cancel-threshold"
            type="number"
            min="30"
            max="600"
            step="30"
            value={threshold}
            onChange={(event) => setThreshold(Number(event.target.value))}
          />
          <span>min</span>
        </label>
      </div>

      <div className="incident-actions">
        <button className="primary-button" onClick={apply} disabled={draft.length === 0}>
          Disrupt network
        </button>
        <button
          className="secondary-button"
          onClick={() => {
            setDraft([])
            onClear()
          }}
        >
          <RotateCcw size={14} /> Reset
        </button>
        <button className="text-button" onClick={addClosure}>
          <Plus size={14} /> Add closure
        </button>
        <button className="text-button" onClick={onDeepDemo}>
          Try 08:00 deep cascade
        </button>
      </div>
    </section>
  )
}
