import { useMemo, useState } from 'react'
import {
  Bot,
  Check,
  GitCompareArrows,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react'
import type {
  AiDispatchResponse,
  CandidateEvaluation,
  Crew,
  Flight,
  RecoveryAction,
  RecoveryWeights,
  SimulationOutput,
  SpareAircraft,
} from '../domain/types'
import { actionLabel, signed } from './format'
import { NumberGuard, type GuardReportView } from './NumberGuard'

interface RecoveryPanelProps {
  baseline: SimulationOutput
  after: SimulationOutput
  candidates: CandidateEvaluation[]
  pairs: CandidateEvaluation[]
  selectedActions: RecoveryAction[]
  weights: RecoveryWeights
  flights: Flight[]
  crews: Crew[]
  spares: SpareAircraft[]
  aiLoading: boolean
  aiResponse: AiDispatchResponse | null
  guardReport: GuardReportView | null
  tamperActive: boolean
  aiError?: string
  onWeightsChange: (weights: RecoveryWeights) => void
  onToggleAction: (action: RecoveryAction) => void
  onManualAction: (action: RecoveryAction) => void
  onAskAi: () => void
  onAcceptAi: () => void
  onRejectAi: () => void
  onTamperTest: () => void
}

type ManualType = 'CANCEL_FLIGHT' | 'ACTIVATE_SPARE' | 'HOLD_FLIGHT' | 'REASSIGN_CREW'

export function RecoveryPanel({
  baseline,
  after,
  candidates,
  pairs,
  selectedActions,
  weights,
  flights,
  crews,
  spares,
  aiLoading,
  aiResponse,
  guardReport,
  tamperActive,
  aiError,
  onWeightsChange,
  onToggleAction,
  onManualAction,
  onAskAi,
  onAcceptAi,
  onRejectAi,
  onTamperTest,
}: RecoveryPanelProps) {
  const [manualType, setManualType] = useState<ManualType>('CANCEL_FLIGHT')
  const [manualTarget, setManualTarget] = useState(flights[0]?.id ?? '')
  const [manualCrewFlight, setManualCrewFlight] = useState(flights[0]?.id ?? '')
  const [manualRotation, setManualRotation] = useState(flights[0]?.tailId ?? '')
  const [holdMinutes, setHoldMinutes] = useState(30)

  const manualOptions = useMemo(() => {
    switch (manualType) {
      case 'CANCEL_FLIGHT':
        return flights.map((flight) => ({ value: flight.id, label: `${flight.id} · ${flight.origin}→${flight.destination}` }))
      case 'ACTIVATE_SPARE':
        return spares.map((spare) => ({ value: spare.id, label: `${spare.id} · base ${spare.base}` }))
      case 'HOLD_FLIGHT':
        return flights.map((flight) => ({ value: flight.id, label: `${flight.id} · ${flight.origin}→${flight.destination}` }))
      case 'REASSIGN_CREW':
        return crews.map((crew) => ({ value: crew.id, label: `${crew.id} · ${crew.tailId}` }))
    }
  }, [flights, spares, crews, manualType])

  const applyManual = () => {
    let action: RecoveryAction | null = null
    if (manualType === 'CANCEL_FLIGHT') {
      action = {
        id: `MANUAL-CANCEL-${manualTarget}`,
        type: 'CANCEL_FLIGHT',
        flightId: manualTarget,
        cost: 1_000,
      }
    } else if (manualType === 'ACTIVATE_SPARE') {
      action = {
        id: `MANUAL-SPARE-${manualTarget}-${manualRotation}`,
        type: 'ACTIVATE_SPARE',
        spareId: manualTarget,
        rotationTailId: manualRotation,
        cost: 1_500,
      }
    } else if (manualType === 'HOLD_FLIGHT') {
      action = {
        id: `MANUAL-HOLD-${manualTarget}-${holdMinutes}`,
        type: 'HOLD_FLIGHT',
        flightId: manualTarget,
        holdMinutes,
        cost: holdMinutes * 5,
      }
    } else {
      action = {
        id: `MANUAL-CREW-${manualTarget}-${manualCrewFlight}`,
        type: 'REASSIGN_CREW',
        crewId: manualTarget,
        flightId: manualCrewFlight,
        cost: 750,
      }
    }
    if (action) onManualAction(action)
  }

  const rotationIds = [...new Set(flights.map((flight) => flight.tailId))].sort()
  const selectedKeys = new Set(selectedActions.map((action) => action.id))
  const evaluatedCount = candidates.length + pairs.length
  const displayedCandidates = [...candidates, ...pairs]
    .filter((candidate) => candidate.delta.costScore < 0)
    .slice(0, 12)
  const changed = selectedActions.length > 0

  return (
    <section className="panel recovery-panel">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-icon"><Sparkles size={16} /></span>
          <div>
            <h2>Recovery workbench</h2>
            <p className="panel-subtitle">Engine-evaluated options; AI selects, explains, and never calculates.</p>
          </div>
        </div>
        <div className="map-legend">
          <span><i style={{ background: 'var(--green)' }} /> improvement</span>
          <span><i style={{ background: 'var(--red)' }} /> regression</span>
        </div>
      </div>

      <div className="recovery-grid">
        <div className="recovery-column">
          <div className="recovery-section-head">
            <div>
              <h3>Objective weights</h3>
              <p>Adjust the dispatcher’s priorities. Scores re-rank immediately.</p>
            </div>
          </div>
          <div className="weight-list">
            {(
              [
                ['delayMinute', 'Delay minute', 0, 20],
                ['cancellation', 'Cancellation', 0, 2_000],
                ['strandedPassenger', 'Stranded passenger', 0, 500],
                ['crewViolation', 'Crew violation', 0, 2_000],
                ['actionCost', 'Action cost', 0, 5],
              ] as const
            ).map(([key, label, min, max]) => (
              <div className="weight-row" key={key}>
                <label htmlFor={`weight-${key}`}>{label}</label>
                <output>{weights[key]}</output>
                <input
                  id={`weight-${key}`}
                  type="range"
                  min={min}
                  max={max}
                  step={key === 'delayMinute' || key === 'actionCost' ? 1 : 50}
                  value={weights[key]}
                  onChange={(event) => onWeightsChange({ ...weights, [key]: Number(event.target.value) })}
                />
              </div>
            ))}
          </div>

          <div className="manual-action-box">
            <div className="recovery-section-head">
              <div>
                <h3>Manual action</h3>
                <p>Apply any deterministic action, including infeasible options for diagnostics.</p>
              </div>
            </div>
            <select value={manualType} onChange={(event) => setManualType(event.target.value as ManualType)}>
              <option value="CANCEL_FLIGHT">Cancel flight</option>
              <option value="ACTIVATE_SPARE">Activate spare</option>
              <option value="HOLD_FLIGHT">Hold flight</option>
              <option value="REASSIGN_CREW">Reassign crew</option>
            </select>
            <select value={manualTarget} onChange={(event) => setManualTarget(event.target.value)}>
              {manualOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
            {manualType === 'ACTIVATE_SPARE' && (
              <select value={manualRotation} onChange={(event) => setManualRotation(event.target.value)}>
                {rotationIds.map((tailId) => (
                  <option value={tailId} key={tailId}>Rotation {tailId}</option>
                ))}
              </select>
            )}
            {manualType === 'REASSIGN_CREW' && (
              <select value={manualCrewFlight} onChange={(event) => setManualCrewFlight(event.target.value)}>
                {flights.map((flight) => (
                  <option value={flight.id} key={flight.id}>
                    Flight {flight.id} · {flight.origin}→{flight.destination}
                  </option>
                ))}
              </select>
            )}
            {manualType === 'HOLD_FLIGHT' && (
              <label className="manual-hold">
                Hold minutes
                <input type="number" min="5" max="180" step="5" value={holdMinutes} onChange={(event) => setHoldMinutes(Number(event.target.value))} />
              </label>
            )}
            <button className="secondary-button" onClick={applyManual}>Apply manual action</button>
          </div>
        </div>

        <div className="recovery-column">
          <div className="recovery-section-head">
            <div>
              <h3>Engine-ranked recovery</h3>
              <p>Click an option to simulate it exactly. Lower weighted score is better.</p>
            </div>
            <GitCompareArrows size={16} />
          </div>
          <div className="candidate-list">
            {displayedCandidates.map((candidate) => {
              const selected = selectedKeys.has(candidate.action.id)
              return (
                <button
                  className={`candidate-card ${selected ? 'is-selected' : ''}`}
                  key={candidate.action.id}
                  onClick={() => onToggleAction(candidate.action)}
                >
                  <div className="candidate-top">
                    <span className="candidate-rank">#{candidate.rank}</span>
                    <strong>{actionLabel(candidate.action)}</strong>
                    <span className="candidate-score">{candidate.after.costScore}</span>
                  </div>
                  <div className="candidate-deltas">
                    <span className={candidate.delta.totalDelayMinutes <= 0 ? 'delta-good' : 'delta-bad'}>
                      Delay {signed(candidate.delta.totalDelayMinutes)}m
                    </span>
                    <span className={candidate.delta.strandedPassengers <= 0 ? 'delta-good' : 'delta-bad'}>
                      Stranded {signed(candidate.delta.strandedPassengers)}
                    </span>
                    <span className={candidate.delta.crewViolations <= 0 ? 'delta-good' : 'delta-bad'}>
                      Crew {signed(candidate.delta.crewViolations)}
                    </span>
                  </div>
                  <p className="candidate-rationale">{candidate.rationale.join(' · ')}</p>
                </button>
              )
            })}
            {displayedCandidates.length === 0 && (
              <div className="empty-state empty-state--small">
                <h3>No action beats the baseline</h3>
                <p>
                  {evaluatedCount} single and paired actions were simulated under the current weights.
                  Adjust the objective or apply a manual diagnostic action.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="recovery-column">
          <div className="ai-card">
            <div className="recovery-section-head">
              <div className="ai-orb"><Bot size={18} /></div>
              <div>
                <h3>AI dispatcher</h3>
                <p>Explanation and selection only.</p>
              </div>
            </div>
            <button className="primary-button ai-ask" onClick={onAskAi} disabled={aiLoading}>
              {aiLoading ? 'Consulting dispatcher…' : 'Ask AI dispatcher'}
            </button>
            {aiError && <div className="guard-warning">{aiError}</div>}
            {aiResponse && (
              <>
                <div className="ai-actions">
                  {aiResponse.chosenActions.map((chosen) => (
                    <button
                      className="ai-chosen"
                      key={chosen.actionId}
                      onClick={() => onToggleAction(chosen.action)}
                    >
                      <strong>{actionLabel(chosen.action)}</strong>
                      <span>{chosen.actionId}</span>
                    </button>
                  ))}
                </div>
                <NumberGuard report={guardReport} tamperActive={tamperActive} />
                <div className="ai-actions">
                  <button className="secondary-button" onClick={onAcceptAi}><Check size={13} /> Accept</button>
                  <button className="secondary-button" onClick={onRejectAi}><X size={13} /> Reject</button>
                </div>
              </>
            )}
            <button className="secondary-button tamper-button" onClick={onTamperTest}>
              <ShieldAlert size={13} /> Run AI tamper test
            </button>
          </div>

          <div className="recovery-section-head compare-heading">
            <div>
              <h3>Before vs after</h3>
              <p>Both columns are generated by the deterministic engine.</p>
            </div>
          </div>
          <div className="before-after">
            <div className="ba-column">
              <h4>Before</h4>
              <div className="ba-metric"><span>Delay min</span><b>{baseline.kpis.totalDelayMinutes}</b></div>
              <div className="ba-metric"><span>Cancelled</span><b>{baseline.kpis.cancelledFlights}</b></div>
              <div className="ba-metric"><span>Stranded</span><b>{baseline.kpis.strandedPassengers}</b></div>
              <div className="ba-metric"><span>Crew faults</span><b>{baseline.kpis.crewViolations}</b></div>
            </div>
            <div className="ba-column">
              <h4>After</h4>
              <div className="ba-metric"><span>Delay min</span><b>{after.kpis.totalDelayMinutes}</b></div>
              <div className="ba-metric"><span>Cancelled</span><b>{after.kpis.cancelledFlights}</b></div>
              <div className="ba-metric"><span>Stranded</span><b>{after.kpis.strandedPassengers}</b></div>
              <div className="ba-metric"><span>Crew faults</span><b>{after.kpis.crewViolations}</b></div>
            </div>
          </div>
          <div className="compare-footer">
            {changed ? (
              <>
                Applied {selectedActions.length} action{selectedActions.length === 1 ? '' : 's'}. The
                post-recovery state is deterministic and can be replayed on the map and Gantt.
              </>
            ) : (
              <>Select a candidate to calculate the exact post-recovery network.</>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
