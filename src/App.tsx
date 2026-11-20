import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Database,
  GitBranch,
  Plane,
  Radio,
  ShieldCheck,
} from 'lucide-react'
import './App.css'
import { loadBundledDataset } from './data/adapter'
import { DEFAULT_RECOVERY_WEIGHTS, searchRecoveryOptions, simulateSimulation } from './engine'
import type {
  AiDispatchRequest,
  AiDispatchResponse,
  AirportClosure,
  RecoveryAction,
  RecoveryWeights,
} from './domain/types'
import { callAiWithRetries } from './ai/dispatcher'
import { buildFallbackDispatch } from './ai/fallback'
import { injectWrongNumber, validateAiResponse, validateNarrative, type ValidationReport } from './validator'
import { IncidentControls } from './ui/IncidentControls'
import { NetworkMap } from './ui/NetworkMap'
import { FlightTable } from './ui/FlightTable'
import { GanttView } from './ui/GanttView'
import { CrewDutyPanel } from './ui/CrewDutyPanel'
import { DelayDna } from './ui/DelayDna'
import { ReplayControls } from './ui/ReplayControls'
import { RecoveryPanel } from './ui/RecoveryPanel'
import { DataHealthPanel } from './ui/DataHealthPanel'
import { ComparisonView } from './ui/ComparisonView'
import type { GuardReportView } from './ui/NumberGuard'
import { formatDelay, replayKpis } from './ui/format'

const loadResult = loadBundledDataset()

function toGuardReport(report: ValidationReport): GuardReportView {
  return {
    valid: report.valid,
    verifiedCount: report.verifiedCount,
    totalCount: report.totalCount,
    warnings: report.warnings,
    sentences: report.sentences.map((sentence) => ({
      text: sentence.text,
      valid: sentence.valid,
      claims: sentence.claims.map((claim) => ({
        raw: claim.raw,
        value: claim.value,
        source: claim.source,
        verified: claim.verified,
      })),
    })),
  }
}

function App() {
  const { dataset, health } = loadResult
  const [closures, setClosures] = useState<AirportClosure[]>([])
  const [threshold, setThreshold] = useState(180)
  const [weights, setWeights] = useState<RecoveryWeights>({ ...DEFAULT_RECOVERY_WEIGHTS })
  const [selectedActions, setSelectedActions] = useState<RecoveryAction[]>([])
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null)
  const [scrubTime, setScrubTime] = useState(720)
  const [playing, setPlaying] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResponse, setAiResponse] = useState<AiDispatchResponse | null>(null)
  const [guardReport, setGuardReport] = useState<GuardReportView | null>(null)
  const [tamperActive, setTamperActive] = useState(false)
  const [aiError, setAiError] = useState<string | undefined>()
  const [lastAiPayload, setLastAiPayload] = useState<AiDispatchRequest | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const baseline = useMemo(
    () => simulateSimulation({
      dataset,
      closures,
      cancellationThresholdMinutes: threshold,
    }),
    [dataset, closures, threshold],
  )

  const after = useMemo(
    () => simulateSimulation({
      dataset,
      closures,
      actions: selectedActions,
      cancellationThresholdMinutes: threshold,
    }),
    [dataset, closures, threshold, selectedActions],
  )

  const recovery = useMemo(
    () => searchRecoveryOptions(
      {
        dataset,
        closures,
        cancellationThresholdMinutes: threshold,
      },
      weights,
    ),
    [dataset, closures, threshold, weights],
  )

  const selectedFlight = selectedFlightId
    ? baseline.flightById[selectedFlightId] ?? after.flightById[selectedFlightId] ?? null
    : null

  const passengerByFlight = useMemo(
    () => Object.fromEntries(dataset.flights.map((flight) => [flight.id, flight.passengers])),
    [dataset.flights],
  )
  const live = replayKpis(baseline, scrubTime, passengerByFlight)

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setScrubTime((current) => (current >= 1440 ? 0 : current + 5))
    }, 80)
    return () => window.clearInterval(timer)
  }, [playing])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const resetRecovery = () => {
    setSelectedActions([])
    setAiResponse(null)
    setGuardReport(null)
    setTamperActive(false)
    setAiError(undefined)
  }

  const applyClosures = (nextClosures: AirportClosure[], nextThreshold: number) => {
    setClosures(nextClosures)
    setThreshold(nextThreshold)
    resetRecovery()
    if (nextClosures.length > 0) {
      setScrubTime(nextClosures[0].start)
      setSelectedFlightId(null)
    }
  }

  const runDemo = () => {
    const demo: AirportClosure[] = [
      {
        id: 'DEMO-BOM-STORM',
        airportId: 'BOM',
        start: 14 * 60,
        end: 15 * 60 + 30,
        label: 'Mumbai thunderstorm',
      },
    ]
    setThreshold(180)
    applyClosures(demo, 180)
    setScrubTime(14 * 60)
    setPlaying(false)
    setToast('Mumbai storm loaded: BOM closed 14:00–15:30.')
  }

  const runDeepDemo = () => {
    const demo: AirportClosure[] = [
      {
        id: 'DEMO-BOM-MORNING',
        airportId: 'BOM',
        start: 8 * 60,
        end: 9 * 60 + 30,
        label: 'Mumbai morning storm',
      },
    ]
    setThreshold(180)
    applyClosures(demo, 180)
    setScrubTime(8 * 60)
    setPlaying(false)
    setToast('Deep cascade loaded: BOM closed 08:00–09:30 with connection and recovery impact.')
  }

  const toggleAction = (action: RecoveryAction) => {
    setSelectedActions((current) => {
      const exists = current.some((item) => item.id === action.id)
      return exists ? current.filter((item) => item.id !== action.id) : [...current, action]
    })
    setAiResponse(null)
    setGuardReport(null)
    setTamperActive(false)
  }

  const buildAiPayload = (): AiDispatchRequest => {
    const improving = recovery.candidates.filter((candidate) => candidate.delta.costScore < 0)
    const improvingPairs = recovery.pairs.filter((candidate) => candidate.delta.costScore < 0)
    return {
      baseline,
      candidates: improving.slice(0, 12),
      pairs: improvingPairs.slice(0, 6),
      weights,
    }
  }

  const askAi = async () => {
    const payload = buildAiPayload()
    setLastAiPayload(payload)
    setAiLoading(true)
    setAiError(undefined)
    setTamperActive(false)
    const fallback = buildFallbackDispatch(payload)
    try {
      const result = await callAiWithRetries(
        payload,
        2,
        (response) => validateAiResponse(response, payload).valid,
        () => fallback,
      )
      setAiResponse(result.response)
      setGuardReport(toGuardReport(validateAiResponse(result.response, payload)))
      if (result.transport === 'fallback') {
        setAiError(`AI endpoint unavailable. Verified deterministic fallback used. ${result.providerError ?? ''}`.trim())
      }
    } catch (error) {
      setAiResponse(fallback)
      setGuardReport(toGuardReport(validateAiResponse(fallback, payload)))
      setAiError(error instanceof Error ? error.message : 'AI dispatcher unavailable.')
    } finally {
      setAiLoading(false)
    }
  }

  const acceptAi = () => {
    if (!aiResponse) return
    const validIds = new Set([
      ...recovery.candidates.map((candidate) => candidate.action.id),
      ...recovery.pairs.map((candidate) => candidate.action.id),
    ])
    const accepted = aiResponse.chosenActions.filter((chosen) => validIds.has(chosen.actionId))
    if (accepted.length === 0) {
      setToast('No valid AI action could be accepted.')
      return
    }
    setSelectedActions(accepted.map((chosen) => chosen.action))
    setToast(`Accepted ${accepted.length} engine-validated action${accepted.length === 1 ? '' : 's'}.`)
  }

  const runTamperTest = () => {
    const payload = lastAiPayload ?? buildAiPayload()
    const baseText = aiResponse?.reasoning
      ?? recovery.candidates[0]?.rationale.join(' ')
      ?? `The baseline has ${baseline.kpis.totalDelayMinutes} delay minutes.`
    const tampered = injectWrongNumber(baseText)
    const report = validateNarrative(tampered, payload)
    setGuardReport(toGuardReport(report))
    setTamperActive(true)
    if (!aiResponse) {
      setAiResponse({
        chosenActions: [],
        reasoning: tampered,
        citedNumbers: [],
      })
    }
    setToast('AI tamper test: one numeric claim was deliberately corrupted.')
  }

  const firstDisrupted = baseline.flights.find((flight) => flight.delayMinutes > 0)
  const demoReady = closures.length > 0
  const actionCount = selectedActions.length
  const invalidActions = after.actionValidation.filter((validation) => !validation.valid)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Plane size={20} /></div>
          <div className="brand-copy">
            <h1>Domino Sky</h1>
            <p>Flight disruption cascade & recovery simulator</p>
          </div>
        </div>
        <div className="top-actions">
          <span className="runtime-pill">Deterministic core</span>
          <button className="secondary-button" onClick={() => setHealthOpen(true)}>
            <Database size={14} /> Data health
          </button>
          <a className="secondary-button" href="#recovery" style={{ textDecoration: 'none' }}>
            <GitBranch size={14} /> Recovery
          </a>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <IncidentControls
            airports={dataset.airports}
            closures={closures}
            thresholdMinutes={threshold}
            onApply={applyClosures}
            onDemo={runDemo}
            onDeepDemo={runDeepDemo}
            onClear={() => {
              applyClosures([], threshold)
              setScrubTime(720)
            }}
          />

          <section className="sidebar-section">
            <h3>Network legend</h3>
            <div className="legend-list">
              <div className="legend-item"><span className="legend-dot green" /> On time / operating</div>
              <div className="legend-item"><span className="legend-dot amber" /> Delay developing</div>
              <div className="legend-item"><span className="legend-dot red" /> Active delay / closure</div>
              <div className="legend-item"><span className="legend-dot grey" /> Cancelled</div>
            </div>
          </section>

          <section className="sidebar-section">
            <h3>Scenario status</h3>
            <div className="legend-list">
              <div className="legend-item"><Radio size={13} /> {closures.length ? `${closures.length} active closure${closures.length === 1 ? '' : 's'}` : 'Network nominal'}</div>
              <div className="legend-item"><Activity size={13} /> {baseline.kpis.delayedFlights} delayed · {baseline.kpis.cancelledFlights} cancelled</div>
              <div className="legend-item"><ShieldCheck size={13} /> Engine-only operational numbers</div>
            </div>
          </section>

          <section className="sidebar-section">
            <h3>Selected flight</h3>
            {selectedFlight ? (
              <div className="closure-chip">
                <span className="closure-status" />
                <div>
                  <strong>{selectedFlight.id} · {formatDelay(selectedFlight.delayMinutes)}</strong>
                  <small>{selectedFlight.tailId} · {selectedFlight.rootCauseLabel ?? 'No delay root'}</small>
                </div>
              </div>
            ) : (
              <p className="closure-empty">Select a flight arc, table row, or Gantt leg to inspect its Delay DNA.</p>
            )}
          </section>
        </aside>

        <main className="main-content">
          <div className="content-grid">
            <section className="panel network-panel">
              <div className="panel-header">
                <div className="panel-title-wrap">
                  <span className="panel-icon"><Plane size={16} /></span>
                  <div>
                    <h2>Network control tower</h2>
                    <p className="panel-subtitle">
                      {demoReady ? 'Disruption active — drag the replay clock to follow the ripple.' : 'Nominal schedule — create an incident or load the Mumbai storm.'}
                    </p>
                  </div>
                </div>
                <div className="map-legend">
                  <span><i style={{ background: 'var(--green)' }} /> on time</span>
                  <span><i style={{ background: 'var(--amber)' }} /> pending delay</span>
                  <span><i style={{ background: 'var(--red)' }} /> disrupted</span>
                  <span><i style={{ background: '#697386' }} /> cancelled</span>
                </div>
              </div>
              <NetworkMap
                airports={dataset.airports}
                flights={dataset.flights}
                results={baseline.flights}
                closures={closures}
                selectedFlightId={selectedFlightId}
                scrubTime={scrubTime}
                onSelectFlight={setSelectedFlightId}
              />
            </section>

            <div className="kpi-strip">
              <div className="kpi-card kpi-warning">
                <span className="kpi-label">Delayed flights</span>
                <strong className="kpi-value">{baseline.kpis.delayedFlights}</strong>
                <span className="kpi-hint">{baseline.kpis.worstDelayMinutes}m worst delay</span>
              </div>
              <div className="kpi-card kpi-danger">
                <span className="kpi-label">Cancelled</span>
                <strong className="kpi-value">{baseline.kpis.cancelledFlights}</strong>
                <span className="kpi-hint">threshold {threshold}m</span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Total delay</span>
                <strong className="kpi-value">{baseline.kpis.totalDelayMinutes}</strong>
                <span className="kpi-hint">network minutes</span>
              </div>
              <div className="kpi-card kpi-warning">
                <span className="kpi-label">Missed connections</span>
                <strong className="kpi-value">{baseline.kpis.missedConnections}</strong>
                <span className="kpi-hint">of {dataset.connections.length} protected flows</span>
              </div>
              <div className="kpi-card kpi-danger">
                <span className="kpi-label">Stranded</span>
                <strong className="kpi-value">{baseline.kpis.strandedPassengers}</strong>
                <span className="kpi-hint">{baseline.kpis.strandedTransferPassengers} transfer pax</span>
              </div>
              <div className="kpi-card kpi-danger">
                <span className="kpi-label">Crew violations</span>
                <strong className="kpi-value">{baseline.kpis.crewViolations}</strong>
                <span className="kpi-hint">duty limit breaches</span>
              </div>
            </div>

            <section className="panel replay-panel">
              <div className="panel-header">
                <div className="panel-title-wrap">
                  <span className="panel-icon"><Activity size={16} /></span>
                  <div>
                    <h2>Cascade replay</h2>
                    <p className="panel-subtitle">Live counters at the scrubbed time, not the final end-of-day total.</p>
                  </div>
                </div>
                <div className="map-legend">
                  <span>{live.delayedFlights} delayed</span>
                  <span>{live.cancelledFlights} cancelled</span>
                  <span>{live.missedConnections} missed</span>
                  <span>{live.strandedPassengers} stranded</span>
                </div>
              </div>
              <ReplayControls
                time={scrubTime}
                playing={playing}
                onTimeChange={setScrubTime}
                onPlayingChange={setPlaying}
                onReset={() => {
                  setPlaying(false)
                  setScrubTime(demoReady ? closures[0].start : 360)
                }}
              />
            </section>

            <section className="panel gantt-panel">
              <div className="panel-header">
                <div className="panel-title-wrap">
                  <span className="panel-icon"><GitBranch size={16} /></span>
                  <div>
                    <h2>Rotation Gantt</h2>
                    <p className="panel-subtitle">Scheduled legs in outline; actual operation and delay bars in colour.</p>
                  </div>
                </div>
                <span className="table-count">{dataset.aircraft.length} tails</span>
              </div>
              <GanttView
                aircraft={dataset.aircraft}
                flights={dataset.flights}
                results={baseline.flights}
                selectedFlightId={selectedFlightId}
                onSelectFlight={setSelectedFlightId}
              />
            </section>

            <section className="panel crew-panel">
              <div className="panel-header">
                <div className="panel-title-wrap">
                  <span className="panel-icon"><ShieldCheck size={16} /></span>
                  <div>
                    <h2>Crew duty</h2>
                    <p className="panel-subtitle">Duty window through actual arrival.</p>
                  </div>
                </div>
                <span className={`status-pill ${baseline.kpis.crewViolations ? 'status-delayed' : 'status-on_time'}`}>
                  {baseline.kpis.crewViolations} violations
                </span>
              </div>
              <CrewDutyPanel crews={baseline.crews} />
            </section>

            <section className="panel flight-panel">
              <div className="panel-header">
                <div className="panel-title-wrap">
                  <span className="panel-icon"><Radio size={16} /></span>
                  <div>
                    <h2>Flight operations</h2>
                    <p className="panel-subtitle">Sort by delay, status, cause, or scheduled departure. Select any leg for Delay DNA.</p>
                  </div>
                </div>
              </div>
              <FlightTable
                flights={dataset.flights}
                results={baseline.flights}
                selectedFlightId={selectedFlightId}
                onSelectFlight={setSelectedFlightId}
              />
            </section>

            <section className="panel dna-panel">
              <div className="panel-header">
                <div className="panel-title-wrap">
                  <span className="panel-icon"><GitBranch size={16} /></span>
                  <div>
                    <h2>Delay DNA</h2>
                    <p className="panel-subtitle">Root-cause lineage with minute-by-minute blame attribution.</p>
                  </div>
                </div>
                {selectedFlight && (
                  <button className="secondary-button" onClick={() => setSelectedFlightId(firstDisrupted?.id ?? null)}>
                    Jump to first delay
                  </button>
                )}
              </div>
              <DelayDna
                flight={selectedFlight}
                flightById={baseline.flightById}
                patientZeros={baseline.patientZeros}
                onSelectFlight={setSelectedFlightId}
              />
            </section>

            <div id="recovery">
              <RecoveryPanel
                baseline={baseline}
                after={after}
                candidates={recovery.candidates}
                pairs={recovery.pairs}
                selectedActions={selectedActions}
                weights={weights}
                flights={dataset.flights}
                crews={dataset.crews}
                spares={dataset.spares}
                aiLoading={aiLoading}
                aiResponse={aiResponse}
                guardReport={guardReport}
                tamperActive={tamperActive}
                aiError={aiError}
                onWeightsChange={setWeights}
                onToggleAction={toggleAction}
                onManualAction={(action) => {
                  setSelectedActions((current) => [...current.filter((item) => item.id !== action.id), action])
                  setToast(`Manual action applied: ${action.id}`)
                }}
                onAskAi={askAi}
                onAcceptAi={acceptAi}
                onRejectAi={() => {
                  setAiResponse(null)
                  setGuardReport(null)
                  setTamperActive(false)
                }}
                onTamperTest={runTamperTest}
              />
            </div>

            {actionCount > 0 && (
              <ComparisonView
                airports={dataset.airports}
                aircraft={dataset.aircraft}
                flights={dataset.flights}
                closures={closures}
                before={baseline}
                after={after}
                selectedFlightId={selectedFlightId}
                scrubTime={scrubTime}
                onSelectFlight={setSelectedFlightId}
              />
            )}
          </div>
        </main>
      </div>

      {healthOpen && <DataHealthPanel health={health} onClose={() => setHealthOpen(false)} />}
      {invalidActions.length > 0 && (
        <div className="toast">
          {invalidActions.length} selected action{invalidActions.length === 1 ? '' : 's'} rejected by the engine: {invalidActions[0].reason}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default App
