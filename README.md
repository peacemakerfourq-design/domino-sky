# Domino Sky

**Flight Disruption Cascade & Recovery Simulator**

Domino Sky is an offline-first, single-page operations simulator. It models airport closures, aircraft rotations, passenger connections, crew duty limits, cancellation thresholds, and recovery actions across the supplied 16-airport network.

The hard boundary is intentional:

> The deterministic engine calculates every operational number. The AI dispatcher may select and explain engine-evaluated actions, but it never calculates delays, cancellations, passenger impact, or crew violations.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). The application and all simulation features work offline; only **Ask AI dispatcher** requires network access and a configured AI endpoint.

Production build and preview:

```bash
npm run build
npm run preview
```

Tests:

```bash
npm test
```

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Offline data                                                        │
│                                                                      │
│ src/data/flight_network.json                                        │
│         │                                                            │
│         ▼                                                            │
│ loadDataset(raw) → validation → typed DatasetLoadResult             │
└─────────┬────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Pure deterministic domain                                            │
│                                                                      │
│ incident + recovery actions                                         │
│          │                                                            │
│          ▼                                                            │
│ engine.ts → flights, cause chains, connections, crews, KPIs, roots │
│          │                                                            │
│          ├──────────────► baseline simulation                       │
│          │                                                            │
│          └──────────────► candidate/pair simulations + exact deltas│
└─────────┬────────────────────────────────────────────────────────────┘
          │ structured engine JSON only
          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ AI dispatcher                                                        │
│                                                                      │
│ /api/dispatcher → provider → structured selection + reasoning        │
│                              │                                       │
│                              ▼                                       │
│ validator/ → sentence-level numeric verification → render or block  │
└─────────┬────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ React UI                                                            │
│                                                                      │
│ incident builder · network map · replay · Gantt · crew meters        │
│ Delay DNA · patient zero · recovery comparison · Number Guard        │
└──────────────────────────────────────────────────────────────────────┘
```

### Modules

- `src/data/` — the single `loadDataset()` adapter and data-health validation.
- `src/domain/` — shared typed contracts.
- `src/engine/` — pure deterministic simulation, recovery generation, and scoring.
- `src/ai/` — provider transport and retry orchestration.
- `src/validator/` — numeric claim extraction, source matching, sentence blocking, tamper test, and code-generated fallback copy.
- `src/ui/` — accessible React control-tower components.
- `api/dispatcher.mjs` — optional server-side AI proxy; the browser never receives an API key.

## How determinism is guaranteed

1. The simulation is a pure TypeScript module. It performs no I/O, uses no clock, and contains no random source.
2. Flights are processed deterministically by tail and `leg_order`.
3. Times are integer minutes from midnight, avoiding locale and daylight-saving ambiguity.
4. Closures, cancellations, turnarounds, connections, duty windows, candidate ranking, and pair ranking use explicit total ordering and stable tie-breakers.
5. Every changed scenario is simulated again through the same engine; the UI never calculates a delay or passenger total independently.
6. Unit tests assert repeated runs are deeply equal, the undisrupted baseline matches the schedule, and every delayed flight’s cause-chain minutes equal its delay.

The dataset describes one operating day in IST. A closure interval is inclusive at its start and exclusive at its end.

## Recovery model

The engine evaluates deterministic actions against the exact same simulation:

- cancel a flight;
- activate a spare aircraft on a compatible rotation;
- swap two aircraft rotations;
- hold a flight;
- reassign a crew to a flight.

Single candidates and top candidate pairs are re-simulated. The result contains exact before/after values and a transparent weighted score. Users can edit every score weight; the ranking updates immediately.

A spare aircraft is feasible only when its base and availability can support the selected rotation. Infeasible options remain diagnosable but are not presented as successful recoveries.

## Number Guard

The Number Guard is a trust boundary, not a disclaimer.

1. The AI receives only the baseline, ranked candidates, candidate pairs, and weights as structured JSON.
2. Its reasoning is split into sentences.
3. Every numeric claim—including percentages, times, and flight identifiers—is extracted.
4. Each value is matched to a source value from the engine JSON.
5. A sentence containing an unsupported value is blocked independently.
6. The app can re-request a corrected explanation up to two times, then uses a code-generated fallback.
7. **Run AI tamper test** deliberately changes a number and demonstrates that the affected sentence is blocked.

The visible badge reports the exact number of verified claims. Hovering an accepted number reveals its source.

## Data health

The adapter reports structural errors and non-fatal warnings, including:

- unknown airport, tail, crew, or flight references;
- duplicate IDs and malformed fields;
- connections at the wrong airport;
- missing aircraft or crew assignments;
- impossible scheduled turnarounds;
- invalid airport capacity;
- aggregate entity counts.

A dataset with errors is not treated as healthy. The data-health panel is available from the header.

## AI configuration

For local Vercel-style development, set:

```bash
OPENAI_API_KEY=your_server_side_key
OPENAI_MODEL=gpt-4.1-mini
```

Optional:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1/chat/completions
```

The deployed app is fully usable without these variables. The UI then falls back to deterministic, code-generated dispatcher copy.

## Deployment

### Vercel

The included `vercel.json` builds the Vite SPA and hosts `api/dispatcher.mjs` as a serverless function.

```bash
npm install
npx vercel
```

Set `OPENAI_API_KEY` in the Vercel project only if the AI dispatcher should be live.

### Static hosting

`npm run build` produces `dist/`. It can be hosted on any static provider. The simulation and template dispatcher work offline; the serverless AI endpoint requires a separate serverless host or proxy.

## Two-minute demo script

1. Open the app and point out the data-health badge: **16 airports, 70 flights, 16 aircraft, 21 connections, 16 crews, 2 spares**.
2. Click **Mumbai storm**. The seeded scenario creates the requested BOM closure from 14:00 for 90 minutes and runs the deterministic baseline.
3. Select the delayed BOM departure, open **Delay DNA**, and follow the delay minute back to the storm.
4. Click **Try 08:00 deep cascade** to tell the full network story: 17 delayed flights, 3 missed connections, 92 stranded transfer passengers, and a recovery trade-off.
5. Drag the replay scrubber from 06:00 to 22:00. Watch green routes become amber, then red; cancelled routes turn grey. Read the live delayed-flight, cancelled-flight, missed-connection, and stranded-passenger counters.
6. Select another late flight and explain its Delay DNA lineage and the patient-zero ranking.
7. Open the crew-duty panel and point out which crew approaches or crosses its legal limit.
8. In **Recovery workbench**, select an improving candidate. The engine re-runs the scenario and shows exact before/after KPI deltas.
9. Ask the **AI dispatcher**. Compare its recommendation with the engine ranking and inspect the green **Verified by engine** badge.
10. Hover a cited number to reveal its source.
11. Click **Run AI tamper test**. The wrong number is caught and its sentence is blocked.
12. Accept or reject the action, then compare the before and after maps and Gantt charts.

## Data assumptions

- `turnaround_before_min` is the actual required turnaround for that leg; the global minimum is used when it is larger.
- A closure blocks both departures and arrivals while the airport is closed.
- A computed departure delay above the configurable threshold cancels the flight.
- Cancelling a leg cancels following legs on that rotation when the aircraft cannot reach their scheduled origins.
- Crew duty runs from `duty_start` through the actual arrival of the crew’s final operated flight.
- Passenger figures are aggregate. “Stranded passengers” uses the engine’s documented aggregate convention; no unsupported claim of unique passenger identity is made.

## License

Provided for the Domino Sky organizer project.
