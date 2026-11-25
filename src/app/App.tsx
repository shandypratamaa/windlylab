import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Activity, AlertTriangle, ArrowRight, BookOpen, CarFront, CheckCircle2, ChevronDown, CircleHelp, Cpu, Cuboid, Eraser, Gauge, GraduationCap, Home, Info, Laptop, Maximize, Move3D, Pause, Plane, Play, Radio, RotateCcw, Sparkles, Sun, Tablet, Wind, X } from 'lucide-react'
import { models, defaultModel } from '../features/model-library/models'
import { airDensityIdealGas, airViscositySutherland, dynamicPressurePa, machNumber, reynoldsNumber } from '../physics/aerodynamic-formulas'
import type { ExperimentSettings, ModelDefinition, SolverJob } from '../types'
import { solverService } from '../features/solver/solver-service'
import SolverFieldPreview from '../features/solver/SolverFieldPreview'
import FlightPanel from '../features/flight/FlightPanel'
import { AIRCRAFT, HoldAltitudeField } from '../features/flight/FlightPanel'
import { configOf, estimateClimb, flyAutopilot, liftModel, planFlight, sectionClFor, tableCl, type FlightMode, type LiftBias, type WingSetting } from '../features/flight/flight-plan'
import { isa, stepFlight, type FlightState } from '../physics/atmosphere'
import CfdView, { type CfdDisplay, type CfdTelemetry } from '../features/cfd/CfdView'
import BrandMark from './BrandMark'
import BlueprintBackdrop from '../features/cfd/BlueprintBackdrop'
import Tutorial, { type TutorialPrep, type TutorialStage } from '../features/tutorial/Tutorial'
import CheatSheet, { type ScenarioApply, type ScenarioSetting } from '../features/tutorial/CheatSheet'
import WelcomeFlow from '../features/cfd/WelcomeFlow'
import { cssGradient, pressureStops, speedStops, vorticityStops } from '../features/cfd/colormaps'
import { describeFlow, type FlowInsight } from '../features/cfd/flow-insights'
import { bodyOf, FRONTAL_CELLS, maxReynoldsFor, RESOLUTION_BASE, tunnelOf, type CfdParams, type CfdResolution, type SmokeMode } from '../physics/lbm/cfd-simulation'
import { airfoilOptions, hasRearWing, type AirfoilCode, type FlapType } from '../physics/lbm/geometry'

/** Flight time runs this many times faster than real time so climbs settle in minutes. */
const DEFAULT_TIME_SCALE = 20

/** Default airliner airspeed (km/h): a typical climb speed, fast enough for the simulated wing to carry the aircraft. */
/** Remembers that the guided tour was finished or skipped, so it only starts on the first visit. */
const TUTORIAL_KEY = 'windlylab.tutorial.v1'
/** Post-stall lift: falls by this share of the maximum per degree past the break-away angle, down to the floor. */
const POST_STALL_DROP = 0.08
const POST_STALL_FLOOR = 0.65
/** Stall warning sounds below this multiple of the stall speed (1.1 = within 10%). */
const STALL_WARNING_MARGIN = 1.1
/** True on localhost, where the optional OpenFOAM cross-check API can run; it is hidden on the hosted site. */
const RUNNING_LOCALLY = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
const AIRLINER_KMH = 700
const initialSettings: ExperimentSettings = {
  angleOfAttackDeg: 4,
  modelScale: 1,
  wind: { airspeedMps: AIRLINER_KMH / 3.6, temperatureC: 20, pressurePa: 101325, characteristicLengthM: defaultModel.metadata.characteristicLengthM },
}

const fieldOptions: readonly { value: CfdDisplay; label: string }[] = [
  { value: 'smoke', label: 'None · dark tunnel' },
  { value: 'velocity', label: 'Velocity magnitude' },
  { value: 'vorticity', label: 'Vorticity (swirl)' },
  { value: 'pressure', label: 'Pressure coefficient (Cp)' },
]
const smokeOptions: readonly { value: SmokeMode; label: string }[] = [
  { value: 'dye', label: 'Realistic smoke' },
  { value: 'particles', label: 'Streakline particles' },
  { value: 'none', label: 'Off' },
]

function Panel({ title, icon, children, className = '', help, badge }: { title: string; icon?: ReactNode; children: ReactNode; className?: string; help?: string; badge?: ReactNode }) {
  const [showHelp, setShowHelp] = useState(false)
  return <section className={`panel ${className}`} data-panel={title}>
    <header className="panel-heading">{icon}<span>{title}</span>{badge}{help && <button type="button" className={`icon-button help-button ${showHelp ? 'active' : ''}`} aria-expanded={showHelp} aria-label={`About ${title.toLowerCase()}`} title="What is this?" onClick={() => setShowHelp(v => !v)}><CircleHelp size={14} /></button>}</header>
    {help && showHelp && <p className="panel-help">{help}</p>}
    <div className="panel-content">{children}</div>
  </section>
}

function Range({ label, value, min, max, step, unit, onChange, display, help }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void; display?: string; help?: string }) {
  return <label className="range-control" title={help}><span className="control-row"><span>{label}{help && <span className="sr-only"> — {help}</span>}</span><span className="value-chip">{display ?? value.toFixed(step < 1 ? 1 : 0)} <small>{unit}</small></span></span><input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ '--range-pct': `${(value - min) * 100 / (max - min)}%` } as CSSProperties} /></label>
}

function Toggle({ label, checked, onChange, help }: { label: string; checked: boolean; onChange: (checked: boolean) => void; help?: string }) {
  return <label className="toggle-row" title={help}><span>{label}</span><input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} /><span className="toggle-switch" aria-hidden="true" /></label>
}

/**
 * Passes `value` through at most once per `intervalMs` while it keeps changing, and
 * always delivers the final value. During a slider drag the tunnel follows along
 * (the worker eases the body between updates) instead of waiting for the drag to end.
 */
function useThrottled<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  const key = JSON.stringify(value)
  useEffect(() => {
    const wait = Math.max(0, last.current + intervalMs - performance.now())
    const timer = window.setTimeout(() => { last.current = performance.now(); setShown(value) }, wait)
    return () => window.clearTimeout(timer)
  }, [key, intervalMs]) // eslint-disable-line react-hooks/exhaustive-deps
  return shown
}

const defaultRearWing = (kind: ModelDefinition['kind']) => kind === 'spoiler' ? 10 : kind === 'wing' ? 8 : 12

/**
 * Text field for a number that the user can freely edit (clear it, type a minus sign,
 * "1e5", …). The value is committed whenever the draft parses to a number inside
 * [min, max]; an invalid draft is flagged and reverts on blur.
 */
function NumberField({ label, value, unit, min, max, decimals, onCommit, help }: { label: string; value: number; unit: string; min: number; max: number; decimals: number; onCommit: (value: number) => void; help?: string }) {
  const format = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(decimals)).toString() : '')
  const [draft, setDraft] = useState(format(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => { if (!editing) setDraft(format(value)) }, [value, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = draft.trim() === '' ? Number.NaN : Number(draft.replace(',', '.'))
  const valid = Number.isFinite(parsed) && parsed >= min && parsed <= max
  return <label className={`number-field ${valid ? '' : 'invalid'}`} title={help}>
    <span>{label}</span>
    <div><input type="text" inputMode="decimal" value={draft} aria-invalid={!valid} aria-label={`${label} in ${unit}`}
      onFocus={() => setEditing(true)}
      onBlur={() => { setEditing(false); setDraft(format(value)) }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      onChange={e => { setDraft(e.target.value); const n = Number(e.target.value.replace(',', '.')); if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) onCommit(n) }} /><small>{unit}</small></div>
    {!valid && <em className="field-error">{min} to {max} {unit}</em>}
  </label>
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <label className="select-control"><span>{label}</span><span className="select-wrap"><select value={value} onChange={e => onChange(e.target.value as T)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select><ChevronDown size={13} /></span></label>
}

function Sparkline({ cd, cl }: { cd: Float32Array; cl: Float32Array }) {
  if (cd.length < 2) return <div className="spark-empty">Collecting force history…</div>
  const values = [...cd, ...cl]
  let lo = Math.min(...values); let hi = Math.max(...values)
  if (hi - lo < 0.2) { const mid = (hi + lo) / 2; lo = mid - 0.1; hi = mid + 0.1 }
  const toPoints = (series: Float32Array) => Array.from(series, (v, i) => `${(i / (series.length - 1) * 220).toFixed(1)},${(56 - (v - lo) / (hi - lo) * 52).toFixed(1)}`).join(' ')
  const zero = lo < 0 && hi > 0 ? 56 - (0 - lo) / (hi - lo) * 52 : null
  return <svg className="cfd-spark" viewBox="0 0 220 60" preserveAspectRatio="none" role="img" aria-label="Recent drag and lift coefficient history">
    {zero !== null && <line x1="0" x2="220" y1={zero} y2={zero} className="spark-zero" />}
    <polyline points={toPoints(cd)} className="spark-cd" /><polyline points={toPoints(cl)} className="spark-cl" />
  </svg>
}

function InsightIcon({ tone, size = 15 }: { tone: FlowInsight['tone']; size?: number }) {
  return tone === 'alert' || tone === 'warn' ? <AlertTriangle size={size} /> : tone === 'good' ? <CheckCircle2 size={size} /> : <Info size={size} />
}

export default function App() {
  const [model, setModel] = useState<ModelDefinition>(defaultModel)
  const [category, setCategory] = useState<ModelDefinition['category']>(defaultModel.category)
  const [settings, setSettings] = useState<ExperimentSettings>(initialSettings)
  const [paused, setPaused] = useState(false)
  const [showWelcome, setShowWelcome] = useState(true)
  const [resolution, setResolution] = useState<CfdResolution>('medium')
  const [simReynolds, setSimReynolds] = useState(4000)
  const [reMode, setReMode] = useState<'auto' | 'manual'>('auto')
  const [flapType, setFlapType] = useState<FlapType>('double')
  const [display, setDisplay] = useState<CfdDisplay>('smoke')
  const [smoke, setSmoke] = useState<SmokeMode>('dye')
  const [smokeLines, setSmokeLines] = useState(24)
  const [airfoil, setAirfoil] = useState<AirfoilCode>('2412')
  const [rearWingDeg, setRearWingDeg] = useState(10)
  // High-lift devices on the airliner wing: 0° = stowed (clean cruise section).
  const [slatDeg, setSlatDeg] = useState(0)
  const [flapDeg, setFlapDeg] = useState(0)
  const [flightOn, setFlightOn] = useState(false)
  /** Guided tour stage (null = not showing) and the cheat-sheet dialog. */
  const [tutorial, setTutorial] = useState<TutorialStage | null>(null)
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false)
  /** Autopilot altitude hold: flies the wing to and holds a chosen altitude. Off until the user turns it on. */
  const [holdAltitude, setHoldAltitude] = useState(false)
  /** Altitude the autopilot holds (the user is asked for it when engaging). */
  const [holdAltitudeM, setHoldAltitudeM] = useState(3000)
  /** Vertical speed for climbs, descents and autopilot altitude changes, m/s. */
  const [verticalRate, setVerticalRate] = useState(8)
  /** Flight time runs this many times faster than real time (slider in the flight panel). */
  const [timeScale, setTimeScale] = useState(DEFAULT_TIME_SCALE)
  /** Altitude Cruise levels off at (where the aircraft was when Cruise was picked). */
  const [cruiseAltitude, setCruiseAltitude] = useState(3000)
  /** Short warning or confirmation shown in the flight-mode box. */
  const [flightNotice, setFlightNotice] = useState<string | null>(null)
  /** Learned difference between the live CFD lift and the lift table, per configuration. */
  const [liftBias, setLiftBias] = useState<LiftBias>({})
  const [autopilotInfo, setAutopilotInfo] = useState<{ saturated: -1 | 0 | 1; commandedRateMps: number } | null>(null)
  const [flightMode, setFlightMode] = useState<FlightMode | null>(null)
  const [altitudeChange, setAltitudeChange] = useState(1000)
  const [initialAltitude, setInitialAltitude] = useState(3000)
  const [flight, setFlight] = useState<FlightState>({ altitudeM: 3000, climbRateMps: 0 })
  const [flightHistory, setFlightHistory] = useState<number[]>([])
  const [massT, setMassT] = useState(200)
  const [sideRelief, setSideRelief] = useState(true)
  const [telemetry, setTelemetry] = useState<CfdTelemetry | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [clearKey, setClearKey] = useState(0)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [toast, setToast] = useState<FlowInsight | null>(null)
  const [solverAvailable, setSolverAvailable] = useState(false)
  const [solverMessage, setSolverMessage] = useState('Checking local OpenFOAM runtime…')
  const [solverJob, setSolverJob] = useState<SolverJob | null>(null)
  const [solverJobSignature, setSolverJobSignature] = useState('')
  const [solverBusy, setSolverBusy] = useState(false)
  const [fieldQuantity, setFieldQuantity] = useState<'velocity' | 'pressure'>('velocity')

  useEffect(() => {
    // The OpenFOAM cross-check needs the local API (npm run dev:all); the hosted site has none.
    if (!RUNNING_LOCALLY) return
    let active = true
    fetch('/api/health').then(response => response.json()).then(payload => {
      if (!active) return
      setSolverAvailable(Boolean(payload.solver?.available))
      setSolverMessage(payload.solver?.message ?? 'Local CFD API did not return solver status.')
    }).catch(() => {
      if (!active) return
      setSolverAvailable(false)
      setSolverMessage('Local OpenFOAM API is offline. Start it with npm run dev:all to cross-check NACA 0012 results.')
    })
    return () => { active = false }
  }, [])

  // Physical air properties: ideal-gas density and Sutherland viscosity from the chosen temperature.
  // With the flight simulation on, the air comes from the standard atmosphere at the aircraft's altitude.
  const flightActive = flightOn && model.kind === 'aircraft-wing'
  const altitudeAir = flightActive ? isa(flight.altitudeM) : null
  const airTemperatureC = altitudeAir ? altitudeAir.temperatureC : settings.wind.temperatureC
  const airPressurePa = altitudeAir ? altitudeAir.pressurePa : settings.wind.pressurePa
  const airDensity = airDensityIdealGas(airPressurePa, airTemperatureC)
  const airViscosity = airViscositySutherland(airTemperatureC)
  const characteristicLength = settings.wind.characteristicLengthM * settings.modelScale
  const re = reynoldsNumber(airDensity, settings.wind.airspeedMps, characteristicLength, airViscosity)
  const mach = machNumber(settings.wind.airspeedMps, airTemperatureC)
  const qInf = dynamicPressurePa(airDensity, settings.wind.airspeedMps)

  const isWing = model.kind === 'aircraft-wing'
  const highLift = isWing && (slatDeg > 0 || flapDeg > 0)
  const bodyParams = { kind: model.kind, airfoil, scale: settings.modelScale, rearWingDeg, slatDeg: isWing ? slatDeg : null, flapDeg: isWing ? flapDeg : null, flapType, resolution }
  const tunnel = useMemo(() => tunnelOf(bodyParams), [model.kind, airfoil, resolution]) // eslint-disable-line react-hooks/exhaustive-deps
  const body = useMemo(() => bodyOf(bodyParams, tunnel), [tunnel, settings.modelScale, rearWingDeg, bodyParams.slatDeg, bodyParams.flapDeg]) // eslint-disable-line react-hooks/exhaustive-deps
  const maxRe = maxReynoldsFor(bodyParams)
  // "Match real air": simulate the actual Reynolds number of these conditions (so speed,
  // size, temperature and pressure all change the flow) up to what the grid can resolve.
  const autoRe = Number.isFinite(re) ? Math.max(30, Math.min(re, maxRe)) : maxRe
  const effectiveRe = Math.round(reMode === 'auto' ? autoRe : Math.min(simReynolds, maxRe))
  const reCapped = reMode === 'auto' && Number.isFinite(re) && re > maxRe
  const liveParams: CfdParams = { ...bodyParams, angleOfAttackDeg: settings.angleOfAttackDeg, reynolds: effectiveRe, smokeLines, sideRelief: sideRelief && model.metadata.hasGround }
  const params = useThrottled(liveParams, 80)
  const bodyCells = Math.round(body.reynoldsLength * tunnel.base)
  const stats = telemetry?.stats
  const forceLengthM = characteristicLength * body.forceLength / body.reynoldsLength
  const results = stats && !stats.diverged ? { cd: stats.cdMean, cl: stats.clMean, dragPerSpan: stats.cdMean * qInf * forceLengthM, liftPerSpan: stats.clMean * qInf * forceLengthM } : null
  const insights = describeFlow(stats, { family: body.family, angleOfAttackDeg: settings.angleOfAttackDeg, hasRearWing: hasRearWing(model.kind), highLift, sideRelief: liveParams.sideRelief })
  const headline = insights[0]

  // Pop up the headline only after it has held for ~1.5 s, so brief flickers between states stay quiet.
  const candidate = useRef({ id: '', since: 0 })
  const shownId = useRef('')
  useEffect(() => {
    if (!headline || headline.id === 'starting' || headline.id === 'settling' || headline.id === 'adapting') return
    const now = performance.now()
    if (candidate.current.id !== headline.id) { candidate.current = { id: headline.id, since: now }; return }
    if (now - candidate.current.since > 1500 && shownId.current !== headline.id) { shownId.current = headline.id; setToast(headline) }
  }, [headline, telemetry])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 9000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (showWelcome || tutorial || cheatSheetOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      if (event.code === 'Space') { event.preventDefault(); setPaused(p => !p) }
      if (event.key === 'r' || event.key === 'R') setResetKey(k => k + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showWelcome, tutorial, cheatSheetOpen])

  // The first time the simulator opens, start the guided tour (it can be skipped).
  useEffect(() => {
    if (showWelcome) return
    try { if (!localStorage.getItem(TUTORIAL_KEY)) setTutorial('basics') } catch { setTutorial('basics') }
  }, [showWelcome])
  const finishTutorial = () => { setTutorial(null); try { localStorage.setItem(TUTORIAL_KEY, 'done') } catch { /* private mode */ } }
  const prepareTutorial = (what: TutorialPrep) => {
    if (what === 'wing' && model.kind !== 'aircraft-wing') chooseModel(models.find(m => m.kind === 'aircraft-wing')!)
    if (what === 'flight-panel' && !flightOn) { setFlightOn(true); startFlightAt(initialAltitude) }
  }

  const updateWind = (key: keyof ExperimentSettings['wind'], value: number) => setSettings(s => ({ ...s, wind: { ...s.wind, [key]: value } }))
  const chooseModel = (next: ModelDefinition) => {
    setModel(next); setCategory(next.category); setRearWingDeg(defaultRearWing(next.kind))
    // Flight modes belong to the airliner; leaving it hands the wing back to manual.
    if (next.kind !== 'aircraft-wing') { setFlightMode(null); setHoldAltitude(false); setAutopilotInfo(null); setFlightNotice(null) }
    // The airliner flies at airliner speed; cars and shapes start at a road/tunnel speed.
    const kmh = next.kind === 'aircraft-wing' ? AIRLINER_KMH : Math.min(settings.wind.airspeedMps * 3.6, 200)
    setSettings(s => ({ ...s, modelScale: 1, wind: { ...s.wind, airspeedMps: kmh / 3.6, characteristicLengthM: next.metadata.characteristicLengthM } }))
  }
  /**
   * Flight modes. Each flies the wing automatically (angle of attack, slat and flaps) at
   * the chosen vertical speed and levels off exactly:
   *  - Cruise: level off and stay where the aircraft is;
   *  - Climb / Descend: from the start altitude (= initial altitude) up or down by the chosen change;
   *  - Autopilot altitude hold: a separate mode that flies to and holds an altitude the user enters.
   * With none of them active the wing is flown by hand (the sliders).
   */
  const flightModes: { id: FlightMode; label: string }[] = [{ id: 'cruise', label: 'Cruise' }, { id: 'climb', label: 'Climb' }, { id: 'descend', label: 'Descend' }]
  const lift = useMemo(() => liftModel(resolution, liftBias), [resolution, liftBias])
  const climbing = flightMode === 'climb' || flightMode === 'descend'
  const plan = useMemo(() => isWing && flightMode ? planFlight({ mode: flightMode, changeM: altitudeChange, baseAltitudeM: flightMode === 'cruise' ? cruiseAltitude : initialAltitude, trueAirspeedMps: settings.wind.airspeedMps, massKg: massT * 1000, wingAreaM2: AIRCRAFT.wingAreaM2, aspectRatio: AIRCRAFT.aspectRatio, model: lift }) : null,
    [isWing, flightMode, altitudeChange, cruiseAltitude, initialAltitude, settings.wind.airspeedMps, massT, lift])
  /** Automatic flight (a flight mode or the autopilot) is flying the wing. */
  const autoFlight = flightActive && (flightMode !== null || holdAltitude)
  /** Altitude the automatic flight flies to. */
  const holdTarget = holdAltitude ? holdAltitudeM : plan?.targetAltitudeM ?? holdAltitudeM
  const autoInputs = { rateMps: verticalRate, trueAirspeedMps: settings.wind.airspeedMps, massKg: massT * 1000, wingAreaM2: AIRCRAFT.wingAreaM2, aspectRatio: AIRCRAFT.aspectRatio, model: lift }
  // Dry run of the climb/descent: rate actually reachable and time to the target.
  const estimate = useMemo(() => isWing && climbing && plan ? estimateClimb(initialAltitude, { ...autoInputs, targetAltitudeM: plan.targetAltitudeM, config: null }) : null,
    [isWing, climbing, plan, initialAltitude, verticalRate, settings.wind.airspeedMps, massT, lift]) // eslint-disable-line react-hooks/exhaustive-deps
  const applySetting = (w: WingSetting) => {
    setSlatDeg(w.slatDeg); setFlapDeg(w.flapDeg)
    const aoa = Math.round(w.angleOfAttackDeg * 10) / 10
    setSettings(s => s.angleOfAttackDeg === aoa ? s : { ...s, angleOfAttackDeg: aoa })
  }
  useEffect(() => {
    if (!flightNotice) return
    const timer = window.setTimeout(() => setFlightNotice(null), 9000)
    return () => window.clearTimeout(timer)
  }, [flightNotice])
  const startFlightAt = (m: number) => { setFlight({ altitudeM: m, climbRateMps: 0 }); setFlightHistory([]) }
  const chooseFlightMode = (mode: FlightMode) => {
    // Clicking the active mode again hands the wing back to the sliders.
    if (mode === flightMode) { setFlightMode(null); setFlightNotice('Manual flying: the angle, slat and flaps stay where they are until you move them.'); return }
    setFlightMode(mode); setHoldAltitude(false); setAutopilotInfo(null); setFlightNotice(null)
    if (!flightOn) setFlightOn(true)
    if (mode === 'cruise') {
      const here = Math.round(flightOn ? flight.altitudeM : initialAltitude)
      setCruiseAltitude(here)
      if (!flightOn) startFlightAt(initialAltitude)
    } else {
      // A climb or descent always starts from the start (initial) altitude; a descent can't go below sea level.
      if (mode === 'descend') setAltitudeChange(c => Math.max(100, Math.min(c, Math.floor(initialAltitude / 100) * 100)))
      startFlightAt(initialAltitude)
    }
  }
  const toggleAutopilot = (on: boolean) => {
    setHoldAltitude(on); setAutopilotInfo(null)
    if (!on) { setFlightNotice('Autopilot off: the wing stays as it is; the aircraft now drifts to where lift equals weight.'); return }
    // Altitude hold is its own mode: it replaces Cruise/Climb/Descend. Ask where to hold, starting from where the aircraft is.
    setFlightMode(null)
    const here = Math.round(flightOn ? flight.altitudeM : initialAltitude)
    setHoldAltitudeM(here)
    if (!flightOn) { setFlightOn(true); startFlightAt(initialAltitude) }
    setFlightNotice(`Autopilot on. Set the altitude to hold below (initial altitude ${initialAltitude.toLocaleString()} m, now ${here.toLocaleString()} m).`)
  }
  /** Changing the start altitude restarts the flight; during a climb/descent it also moves the target, so say so. */
  const changeInitialAltitude = (m: number) => {
    setInitialAltitude(m); startFlightAt(m)
    if (flightMode === 'cruise') setCruiseAltitude(m)
    if (climbing) {
      const target = Math.max(0, Math.min(13000, m + (flightMode === 'climb' ? altitudeChange : -altitudeChange)))
      setFlightNotice(`Start altitude changed to ${m.toLocaleString()} m: the ${flightMode} now runs ${m.toLocaleString()} → ${target.toLocaleString()} m and the flight restarted.`)
    }
  }
  /** Moving the angle, slat or flaps by hand takes over from the automatic flight. */
  const flyByHand = () => {
    if (!flightMode && !holdAltitude) return
    setFlightMode(null); setHoldAltitude(false); setAutopilotInfo(null)
    setFlightNotice('Automatic flight disconnected: you moved the wing by hand.')
  }
  /**
   * One-click scenario from the cheat sheet: close it, fly the wing by hand at the given
   * slat/flap/angle, optionally change to a second setting a few seconds later (to watch
   * lift fall) or open the flight panel at an airspeed with ~15% more lift than weight.
   */
  const scenarioTimer = useRef(0)
  const setWing = (w: ScenarioSetting) => {
    setSlatDeg(w.slat); setFlapDeg(w.flap)
    setSettings(s => ({ ...s, angleOfAttackDeg: w.aoa }))
  }
  const applyScenario = (a: ScenarioApply) => {
    window.clearTimeout(scenarioTimer.current)
    setCheatSheetOpen(false)
    if (model.kind !== 'aircraft-wing') chooseModel(models.find(m => m.kind === 'aircraft-wing')!)
    setFlightMode(null); setHoldAltitude(false); setAutopilotInfo(null)
    setWing(a)
    let note = `Applied: ${a.label}.`
    if (a.climb) {
      const cl = sectionClFor(lift, { angleOfAttackDeg: a.aoa, slatDeg: a.slat, flapDeg: a.flap }) ?? 0.3
      const wingCl = Math.max(0.05, cl * AIRCRAFT.aspectRatio / (AIRCRAFT.aspectRatio + 2))
      const rho = isa(initialAltitude).densityKgM3
      const v = Math.sqrt(1.15 * 2 * massT * 1000 * 9.80665 / (rho * AIRCRAFT.wingAreaM2 * wingCl))
      const kmh = Math.max(10, Math.min(900, Math.round(v * 3.6 / 5) * 5))
      setSettings(s => ({ ...s, wind: { ...s.wind, airspeedMps: kmh / 3.6 } }))
      setFlightOn(true); startFlightAt(initialAltitude)
      note += ` Airspeed set to ${kmh} km/h so lift is about 15% above weight: watch the flight panel climb.`
    }
    if (a.then) {
      const then = a.then
      scenarioTimer.current = window.setTimeout(() => { setWing(then); setFlightNotice(`Now changed to slat ${then.slat}°, flaps ${then.flap}°, ${then.aoa}°: watch Cl in Results.`) }, 4000)
      note += ` It changes to slat ${then.slat}°, flaps ${then.flap}°, ${then.aoa}° in 4 s.`
    }
    setFlightNotice(note)
  }
  useEffect(() => () => window.clearTimeout(scenarioTimer.current), [])
  const restartFlight = () => { startFlightAt(initialAltitude); setCruiseAltitude(initialAltitude) }

  const resetExperiment = () => {
    setSettings(initialSettings); setModel(defaultModel); setCategory(defaultModel.category); setPaused(false)
    setSlatDeg(0); setFlapDeg(0); setFlapType('double'); setFlightOn(false); setHoldAltitude(false); setHoldAltitudeM(3000); setVerticalRate(8); setTimeScale(DEFAULT_TIME_SCALE); setCruiseAltitude(3000); setFlightNotice(null); setLiftBias({}); setFlightMode(null); setAltitudeChange(1000); setInitialAltitude(3000); setMassT(200); setFlight({ altitudeM: 3000, climbRateMps: 0 }); setFlightHistory([]); setReMode('auto'); setSideRelief(true); setRearWingDeg(10); setResolution('medium'); setSimReynolds(4000); setSmoke('dye'); setDisplay('smoke')
    setResetKey(k => k + 1); setClearKey(k => k + 1); setWorkerError(null)
  }
  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) await document.querySelector('.viewport-column')?.requestFullscreen()
    else await document.exitFullscreen()
  }
  const reSlider = (value: number) => { const raw = 10 ** value; const stepSize = raw > 1000 ? 100 : 10; return Math.round(raw / stepSize) * stepSize }

  const inputSignature = [model.id, settings.angleOfAttackDeg, settings.wind.airspeedMps, settings.wind.temperatureC, settings.wind.pressurePa].join('|')
  const solverResultCurrent = solverJobSignature === inputSignature && solverJob?.status === 'Completed' && Boolean(solverJob.results)
  const runSolver = async () => {
    if (solverBusy || !solverAvailable || model.kind !== 'aircraft-wing') return
    setSolverBusy(true); setSolverJob(null); setSolverJobSignature(inputSignature)
    try {
      let job = await solverService.submit({ angleOfAttackDeg: settings.angleOfAttackDeg, airspeedMps: settings.wind.airspeedMps, densityKgM3: airDensity, dynamicViscosityPaS: airViscosity })
      setSolverJob(job)
      while (job.status === 'Queued' || job.status === 'Running') {
        await new Promise(resolve => window.setTimeout(resolve, 1200))
        job = await solverService.getJob(job.id)
        setSolverJob(job)
      }
      if (job.status === 'Failed') setSolverMessage(job.message ?? job.error ?? 'The OpenFOAM run did not complete.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The local CFD request failed.'
      setSolverMessage(message)
      setSolverJob({ id: 'request-error', status: 'Failed', message, error: message })
    } finally {
      setSolverBusy(false)
    }
  }

  // Lift the flight model uses: the lift table (corrected by the learned CFD bias) for the
  // configuration that is set, or the settled CFD lift for hand-set slat/flap angles.
  const config = isWing ? configOf(slatDeg, flapDeg) : null
  const settledCl = stats?.settled && !stats.diverged ? stats.clMean : null
  const configLine = config ? lift.find(l => l.name === config) ?? null : null
  /** Past the angle where the air breaks away the lift line no longer holds: lift falls off (a stall). */
  const stalledFraction = configLine && settings.angleOfAttackDeg > configLine.aoaMax ? Math.max(POST_STALL_FLOOR, 1 - POST_STALL_DROP * (settings.angleOfAttackDeg - configLine.aoaMax)) : null
  const flightCl = configLine ? (stalledFraction !== null ? configLine.clMax * stalledFraction : sectionClFor(lift, { angleOfAttackDeg: settings.angleOfAttackDeg, slatDeg, flapDeg })) : settledCl

  // Stall speed (lift = weight at the wing's maximum lift) for the slat/flap setting in use;
  // the autopilot may extend flaps, so for it the best setting counts.
  const stallInfo = (() => {
    if (!isWing) return null
    const best = lift.reduce((a, l) => (l.clMax > a.clMax ? l : a))
    const line = autoFlight ? best : configLine
    const rho = (flightActive ? isa(flight.altitudeM) : null)?.densityKgM3 ?? airDensity
    const vs = line && Number.isFinite(rho) ? Math.sqrt(2 * massT * 1000 * 9.80665 / (rho * AIRCRAFT.wingAreaM2 * line.clMax * AIRCRAFT.aspectRatio / (AIRCRAFT.aspectRatio + 2))) : null
    const v = settings.wind.airspeedMps
    const name = line?.name === 'clean' ? 'clean wing' : line?.name ?? 'this setting'
    if (configLine && stalledFraction !== null) return { level: 'stall' as const, text: `STALL — ${settings.angleOfAttackDeg.toFixed(1)}° is past where the air breaks away from the ${name} (about ${configLine.aoaMax.toFixed(1)}° on this grid). Lower the angle of attack.` }
    if (!flightActive || vs === null) return null
    if (v < vs) return { level: 'stall' as const, text: `STALL — ${Math.round(v * 3.6)} km/h is below the ${name} stall speed of ${Math.round(vs * 3.6)} km/h for ${massT} t at ${Math.round(flight.altitudeM).toLocaleString()} m: the wing can't carry the aircraft. Add speed${line === best ? '' : ', extend slats and flaps'} or lower the mass.` }
    if (v < STALL_WARNING_MARGIN * vs) return { level: 'warning' as const, text: `STALL WARNING — airspeed ${Math.round(v * 3.6)} km/h is within ${Math.round((STALL_WARNING_MARGIN - 1) * 100)}% of the ${name} stall speed (${Math.round(vs * 3.6)} km/h at this weight and altitude).` }
    return null
  })()
  // Learn the bias from well-converged CFD readings on a known configuration only (0.5
  // flow-throughs past the re-settle): early readings would nudge the autopilot, which
  // would move the wing and restart the re-settle in an endless loop.
  const convergedCl = settledCl !== null && stats && stats.flowThroughs >= stats.settleFlowThroughs + 0.5 ? settledCl : null
  useEffect(() => {
    if (!config || convergedCl === null) return
    const settledCl = convergedCl
    const table = tableCl(resolution, config, settings.angleOfAttackDeg)
    if (table === null) return
    const measured = Math.max(-0.4, Math.min(0.4, settledCl - table))
    // Low-Reynolds-number lift is unsteady, so blend each reading in gently and ignore small changes.
    setLiftBias(b => Math.abs((b[config] ?? 0) - measured) < 0.05 ? b : { ...b, [config]: 0.7 * (b[config] ?? 0) + 0.3 * measured })
  }, [convergedCl, config, resolution]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLiftBias({}) }, [resolution])

  // Flight integration at 10 Hz (cheap; the UI only needs a smooth altitude readout).
  const flightRef = useRef(flight)
  flightRef.current = flight
  /** Wing setting the autopilot last sent to the tunnel, and when. */
  const lastApplied = useRef({ aoa: NaN, config: '' as string, time: 0 })
  const flightInputs = useRef({ v: 0, cl: null as number | null, mass: 0, autopilot: false, target: 0, rate: 8, lift, config: null as typeof config, timeScale: DEFAULT_TIME_SCALE })
  flightInputs.current = { v: settings.wind.airspeedMps, cl: flightCl, mass: massT * 1000, autopilot: autoFlight, target: holdTarget, rate: verticalRate, lift, config, timeScale }
  useEffect(() => {
    if (!flightActive || paused) return
    const timer = window.setInterval(() => {
      const i = flightInputs.current
      const dt = 0.1 * i.timeScale
      let next: FlightState
      if (i.autopilot) {
        const r = flyAutopilot(flightRef.current, { targetAltitudeM: i.target, rateMps: i.rate, trueAirspeedMps: i.v, massKg: i.mass, wingAreaM2: AIRCRAFT.wingAreaM2, aspectRatio: AIRCRAFT.aspectRatio, model: i.lift, config: i.config }, dt)
        next = r.state
        // Move the tunnel wing in fewer, larger steps so the CFD isn't re-settling non-stop
        // (a re-settle takes ~2 s on the default grid): configuration changes at once, angle
        // changes of ≥0.5° at most every 3 s, and fine corrections (≥0.1°) every 15 s.
        const now = performance.now()
        const last = lastApplied.current
        const delta = Math.abs(r.setting.angleOfAttackDeg - last.aoa)
        const since = now - last.time
        if (r.setting.config !== last.config || (delta >= 0.5 && since > 3000) || (delta >= 0.1 && since > 15000)) {
          applySetting(r.setting)
          lastApplied.current = { aoa: r.setting.angleOfAttackDeg, config: r.setting.config, time: now }
        }
        setAutopilotInfo({ saturated: r.saturated, commandedRateMps: r.commandedRateMps })
      } else {
        if (i.cl === null) return
        next = stepFlight(flightRef.current, { trueAirspeedMps: i.v, sectionCl: i.cl, massKg: i.mass, wingAreaM2: AIRCRAFT.wingAreaM2, aspectRatio: AIRCRAFT.aspectRatio }, dt)
      }
      flightRef.current = next
      setFlight(next)
      setFlightHistory(h => [...h.slice(-299), next.altitudeM])
    }, 100)
    return () => window.clearInterval(timer)
  }, [flightActive, paused]) // eslint-disable-line react-hooks/exhaustive-deps

  const fmtDuration = (sec: number) => sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round(sec % 3600 / 60)} min` : sec >= 60 ? `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s` : `${Math.round(sec)} s`
  const kmh = Math.round(settings.wind.airspeedMps * 3.6)
  const minKmh = plan ? Math.ceil(plan.minAirspeedMps * 3.6 / 10) * 10 : 0
  const flightModeReadout = !isWing ? null
    : climbing && plan && estimate ? <div className={`plan-readout ${estimate.seconds === null ? 'plan-warn' : ''}`}>
      <p><b>{initialAltitude.toLocaleString()} → {Math.round(plan.targetAltitudeM).toLocaleString()} m</b> · {flightMode === 'climb' ? 'climb' : 'descent'} at <b>{verticalRate} m/s</b> ({Math.round(verticalRate * 196.85).toLocaleString()} ft/min) · {kmh} km/h · {massT} t</p>
      {estimate.seconds !== null
        ? <p>Time to {Math.round(plan.targetAltitudeM).toLocaleString()} m: <b>{fmtDuration(estimate.seconds)}</b> of flight ({fmtDuration(estimate.seconds / timeScale)} on screen at ×{timeScale} time speed){estimate.limited ? <>, but the wing can only manage about <b>{Math.abs(estimate.peakRateMps).toFixed(1)} m/s</b> here</> : null}.</p>
        : <p>Can't reach {Math.round(plan.targetAltitudeM).toLocaleString()} m at {kmh} km/h: the wing runs out of lift. {plan.feasible ? 'Ask for a lower rate or fly faster.' : <>Needs at least <b>{minKmh} km/h</b>.</>}</p>}
      <p>The angle, slats and flaps adjust automatically to hold this rate and level off on the target.</p>
    </div>
    : flightMode === 'cruise' && plan ? <p className={`plan-readout ${plan.feasible ? '' : 'plan-warn'}`}>{plan.feasible
      ? <>Level at <b>{Math.round(plan.targetAltitudeM).toLocaleString()} m</b> · {kmh} km/h · {massT} t. The angle, slats and flaps adjust automatically to stay level.</>
      : <>Too slow to stay level with {massT} t at {Math.round(plan.targetAltitudeM).toLocaleString()} m. Needs at least <b>{minKmh} km/h</b>; the aircraft will sink.</>}</p>
    : holdAltitude ? <p className="plan-readout">Autopilot {flightActive ? <>flying to and holding <b>{Math.round(holdAltitudeM).toLocaleString()} m</b> at up to {verticalRate} m/s, adjusting the angle, slats and flaps.</> : 'will start with the flight.'}</p>
      : <p className="plan-readout">Flying by hand: you set the angle, slat and flaps. Pick Cruise, Climb or Descend, or turn on the autopilot to hold an altitude.</p>
  const autoStatus = autoFlight && autopilotInfo && autopilotInfo.saturated !== 0
    ? <p className="plan-readout plan-warn">{autopilotInfo.saturated === 1 ? 'At full lift (slats, flaps and angle at their limit): climbing slower than asked or sinking.' : 'At minimum lift: descending slower than asked.'}</p> : null

  if (showWelcome) return <WelcomePage onStart={() => setShowWelcome(false)} />
  const shownModels = models.filter(item => item.category === category)
  const settlingPct = stats ? Math.min(100, Math.round(stats.flowThroughs / stats.settleFlowThroughs * 100)) : 0

  return <main className="app-shell">
    {tutorial && <Tutorial stage={tutorial} prepare={prepareTutorial} onSkip={finishTutorial}
      onBasicsDone={next => { if (next === 'continue') setTutorial('advanced'); else { finishTutorial(); if (next === 'cheat-sheet') setCheatSheetOpen(true) } }}
      onAdvancedDone={openSheet => { finishTutorial(); if (openSheet) setCheatSheetOpen(true) }} />}
    {cheatSheetOpen && <CheatSheet resolution={resolution} onClose={() => setCheatSheetOpen(false)} onApply={applyScenario} />}
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><BrandMark size={19} /></span><span className="brand-text"><span className="brand-name">WindlyLab</span><span className="brand-by">By Shandy Putra</span></span><span className="version-tag">CFD</span></div>
      <div className="top-separator" />
      <div className="project-name"><span className="eyebrow">WIND TUNNEL</span><b>{model.name}</b></div>
      <div className="top-status"><span className={stats?.diverged ? 'status-dot status-dot-warn' : 'status-dot'} /> {telemetry ? `${telemetry.grid.nx}×${telemetry.grid.ny} cells · ${Math.round(telemetry.stepsPerSecond)} steps/s` : 'Starting solver…'}</div>
      <div className="toolbar-spacer" />
      <div className="help-buttons">
        <button className="toolbar-button toolbar-accent" onClick={() => { setCheatSheetOpen(false); setTutorial('basics') }} title="Guided tour of the simulator"><GraduationCap size={14} /><span>Tutorial</span></button>
        <button className="toolbar-button" onClick={() => setCheatSheetOpen(true)} title="Symbols, scenarios and controls on one page"><BookOpen size={14} /><span>Cheat sheet</span></button>
      </div>
      <button className="toolbar-button" onClick={() => setShowWelcome(true)} title="Return to welcome page"><Home size={14} /><span>Welcome</span></button>
      <button className="toolbar-button" onClick={() => setPaused(p => !p)} title={`${paused ? 'Resume' : 'Pause'} (Space)`}>{paused ? <Play size={14} /> : <Pause size={14} />}<span>{paused ? 'Resume' : 'Pause'}</span></button>
      <button className="toolbar-button" onClick={() => setResetKey(k => k + 1)} title="Restart the flow from rest (R)"><RotateCcw size={14} /><span>Restart flow</span></button>
      <button className="toolbar-button" onClick={resetExperiment} title="Reset every setting"><Eraser size={14} /><span>Reset all</span></button>
    </header>
    <div className="workspace">
      <aside className="left-sidebar">
        <div className="sidebar-title"><span>MODEL LIBRARY</span></div>
        <div className="category-tabs">{(['Basic shapes', 'Cars', 'Aircraft'] as const).map((c, i) => <button key={c} className={category === c ? 'selected' : ''} onClick={() => { setCategory(c); if (model.category !== c) chooseModel(models.find(m => m.category === c)!) }} title={c}>{i === 0 ? <Cuboid size={13} /> : i === 1 ? <CarFront size={13} /> : <Plane size={13} />}<span>{i === 0 ? 'Shapes' : c}</span></button>)}</div>
        <div className="model-list">{shownModels.map(item => <button key={item.id} aria-label={item.name} aria-pressed={model.id === item.id} className={`model-option ${model.id === item.id ? 'chosen' : ''}`} onClick={() => chooseModel(item)}><span className="model-glyph">{item.category === 'Cars' ? <CarFront size={15} /> : item.category === 'Aircraft' ? <Plane size={15} /> : <Cuboid size={15} />}</span><span>{item.name}</span>{model.id === item.id && <span className="selection-mark" />}</button>)}</div>
        <div className="approx-note"><Info size={13} /><p>{model.metadata.approximation}. Solved as a 2D section.</p></div>
        <Panel title="GEOMETRY" icon={<Move3D size={13} />} className="geometry-panel">
          {isWing && <Select label="Airfoil" value={airfoil} options={airfoilOptions} onChange={setAirfoil} />}
          {body.pitchable
            ? <Range label="Angle of attack" value={settings.angleOfAttackDeg} min={-10} max={25} step={0.5} unit="°" onChange={v => { flyByHand(); setSettings(s => ({ ...s, angleOfAttackDeg: v })) }} help="Tilts the shape nose-up about a quarter of the way back. The air keeps flowing, so you can watch it react." />
            : <p className="panel-note geometry-note">{model.metadata.hasGround ? 'Cars sit level on a moving road belt.' : 'This shape looks the same from any angle.'}</p>}
          <Range label="Model scale" value={settings.modelScale} min={0.5} max={2.5} step={0.05} unit="×" onChange={v => setSettings(s => ({ ...s, modelScale: v }))} display={settings.modelScale.toFixed(2)} help="Resizes the model inside the tunnel. 1× keeps it under 5% of the tunnel height; bigger models squeeze the air more (more blockage) and are drawn with more grid cells." />
          <div className="scale-readout"><span>Tunnel blockage <b className={stats && stats.blockage > 0.1 ? 'warn-text' : ''}>{stats ? `${(stats.blockage * 100).toFixed(1)}%` : '—'}</b></span><span>{bodyCells} cells long</span></div>
          {hasRearWing(model.kind) && <Range label={model.kind === 'spoiler' ? 'Spoiler angle' : 'Rear wing angle'} value={rearWingDeg} min={-5} max={30} step={1} unit="°" onChange={setRearWingDeg} help="Tilts the rear spoiler or wing on its own. More angle pushes the tail down harder but adds drag." />}
          {isWing && <div className="high-lift">
            <div className="high-lift-head"><span>High-lift devices</span><span className="high-lift-legend"><i className="lg-slat" /> slat <i className="lg-flap" /> flaps</span></div>
            <div className="flight-plan">
              <div className="flight-plan-title">Flight mode</div>
              <div className="preset-row" role="group" aria-label="Flight mode">{flightModes.map(m => <button key={m.id} type="button" className={`preset ${flightMode === m.id ? 'active' : ''}`} aria-pressed={flightMode === m.id} title={flightMode === m.id ? 'Click again to fly by hand' : undefined} onClick={() => chooseFlightMode(m.id)}>{m.label}</button>)}</div>
              {climbing && <>
                <Range label="Start altitude" value={initialAltitude} min={0} max={13000} step={100} unit=" m" display={initialAltitude.toLocaleString()} onChange={changeInitialAltitude} help="Where the climb or descent starts (the same as Initial altitude in the flight panel, 3,000 m by default). Changing it restarts the flight and moves the target." />
                <Range label={flightMode === 'climb' ? 'Altitude to gain' : 'Altitude to lose'} value={altitudeChange} min={100} max={flightMode === 'descend' ? Math.max(100, Math.floor(initialAltitude / 100) * 100) : 6000} step={100} unit=" m" display={altitudeChange.toLocaleString()} onChange={setAltitudeChange} help="How far the aircraft climbs or descends from the start altitude before levelling off." />
              </>}
              <Toggle label="Autopilot (altitude hold)" checked={holdAltitude} onChange={toggleAutopilot} help="A separate mode: flies the angle of attack, slat and flaps itself to reach and hold the altitude you set. Turning it on replaces Cruise/Climb/Descend; Cruise, Climb and Descend never turn it on." />
              {holdAltitude && <HoldAltitudeField value={holdAltitudeM} onChange={setHoldAltitudeM} initialAltitudeM={initialAltitude} currentAltitudeM={flight.altitudeM} />}
              {(climbing || holdAltitude) && <Range label={flightMode === 'descend' ? 'Rate of descent' : flightMode === 'climb' ? 'Rate of climb' : 'Vertical speed'} value={verticalRate} min={1} max={20} step={0.5} unit="" display={`${verticalRate} m/s · ${Math.round(verticalRate * 196.85).toLocaleString()} ft/min`} onChange={setVerticalRate} help="How fast to climb or descend. The wing's angle, slats and flaps adjust automatically to hold this rate, easing off over the last ~100 m to level off exactly." />}
              {flightModeReadout}
              {autoStatus}
              {flightNotice && <p className="plan-readout plan-notice" role="status">{flightNotice}</p>}
            </div>
            <Range label="Slat" value={slatDeg} min={0} max={30} step={1} unit="°" display={slatDeg === 0 ? 'stowed' : String(slatDeg)} onChange={v => { flyByHand(); setSlatDeg(v) }} help="0° = stowed flush in the nose. Deploying slides it forward and down, opening a slot that keeps air attached at steep angles." />
            <Range label="Flaps" value={flapDeg} min={0} max={40} step={1} unit="°" display={flapDeg === 0 ? 'stowed' : String(flapDeg)} onChange={v => { flyByHand(); setFlapDeg(v) }} help="0° = stowed under the wing. Deploying runs them aft and down; the aft flap deflects further. More lift, more drag." />
            <Select label="Flap type" value={flapType} options={[{ value: 'double', label: 'Double-slotted' }, { value: 'single', label: 'Single-slotted' }] as const} onChange={setFlapType} />
            {highLift && resolution !== 'high' && <div className="grid-hint"><span>Slots are only ~2 cells wide on this grid.</span><button type="button" className="subtle-button" onClick={() => setResolution('high')}>Use High grid</button></div>}
          </div>}
          {model.metadata.hasGround && <Toggle label="Side relief (2.5D)" checked={sideRelief} onChange={setSideRelief} help="Real cars let air slip around their sides. This lets low-pressure areas around the car refill, which nudges lift and drag towards a 3D car for some shapes but not others. It is an approximation, not a 3D simulation." />}
          <p className="panel-note">{body.description}.</p>
        </Panel>
        <div className="sidebar-foot"><span className="foot-led" /> SOLVER RUNS IN YOUR BROWSER</div>
      </aside>

      <section className="viewport-column">
        <div className="viewport-head"><div className="view-title"><span className="view-led" /> CFD WIND TUNNEL <span className="viewport-subtitle">{model.name.toUpperCase()}</span></div><div className="viewport-actions"><span className="view-hint">CLICK TO ADD SMOKE <i>·</i> HOVER TO PROBE <i>·</i> SPACE PAUSES</span><button className="icon-button" title="Toggle fullscreen" aria-label="Toggle fullscreen" onClick={toggleFullscreen}><Maximize size={14} /></button></div></div>
        <div className="viewport-content">
          <div className="profile-pane cfd-pane">
            <CfdView params={params} running={!paused} smoke={smoke} display={display} airspeedMps={settings.wind.airspeedMps} resetKey={resetKey} clearEmittersKey={clearKey} onTelemetry={next => { setTelemetry(next); if (!next.stats.diverged) setWorkerError(null) }} onError={setWorkerError} />
            <div className="scene-overlay">
              <span className="overlay-tag"><span className={stats?.settled ? 'live-pip' : 'live-pip live-pip-wait'} /> {paused ? 'PAUSED' : stats ? stats.settled ? 'STATISTICS SETTLED' : `${stats.settleFlowThroughs < 1.2 ? 'ADAPTING' : 'SETTLING'} ${settlingPct}%` : 'STARTING'}</span>
              {stats && <span className="overlay-tag">Re<sub>sim</sub> {Math.round(stats.reynolds).toLocaleString()} <i className="overlay-sep">·</i> Cd {stats.cdMean.toFixed(3)} <i className="overlay-sep">·</i> Cl {stats.clMean.toFixed(3)}</span>}
            </div>
            {stallInfo && <div className={`stall-banner stall-${stallInfo.level}`} role="alert"><AlertTriangle size={16} /><span>{stallInfo.text}</span></div>}
            {toast && <div className={`insight-toast tone-${toast.tone}`} role="status" aria-live="polite">
              <span className="insight-icon"><InsightIcon tone={toast.tone} size={17} /></span>
              <div><b>{toast.title}</b><p>{toast.detail}</p></div>
              <button className="icon-button" aria-label="Dismiss" onClick={() => setToast(null)}><X size={14} /></button>
            </div>}
            {stats?.diverged && <div className="cfd-alert" role="alert"><b>The simulation broke down.</b> The air became too wild for this grid to follow. Turn the Reynolds number down or pick a finer grid, then press Restart flow.<button className="subtle-button" onClick={() => setResetKey(k => k + 1)}><RotateCcw size={13} /> Restart flow</button></div>}
            {workerError && <div className="cfd-alert" role="alert"><b>The simulator stopped unexpectedly.</b> Reload the page to start it again. ({workerError})</div>}
            {display !== 'smoke' && <div className="cfd-colorbar"><span>{display === 'velocity' ? 'Air speed vs wind speed' : display === 'vorticity' ? 'Spin · blue clockwise, red anticlockwise' : 'Pressure (Cp) · blue low, white normal, red high'}</span><i style={{ background: cssGradient(display === 'velocity' ? speedStops : display === 'vorticity' ? vorticityStops : pressureStops) }} /><div>{display === 'velocity' ? <><b>still</b><b>wind speed</b><b>1.6×</b></> : display === 'vorticity' ? <><b>↻</b><b>none</b><b>↺</b></> : <><b>−2</b><b>0</b><b>+1</b></>}</div></div>}
          </div>
        </div>
        {model.kind === 'aircraft-wing' && <FlightPanel stallWarning={stallInfo} enabled={flightOn} onToggle={on => { setFlightOn(on); if (on) restartFlight(); else { setFlightMode(null); setHoldAltitude(false); setAutopilotInfo(null) } }} initialAltitudeM={initialAltitude} onInitialAltitude={changeInitialAltitude}
          initialAltitudeWarning={climbing ? `This is also the ${flightMode} start: changing it restarts the flight and moves the target (now ${Math.round(holdTarget).toLocaleString()} m).` : null}
          flight={flight} history={flightHistory} holdTargetM={holdTarget} holdAltitude={holdAltitude} onHoldAltitude={toggleAutopilot} holdAltitudeM={holdAltitudeM} onHoldAltitudeM={setHoldAltitudeM}
          modeLabel={holdAltitude ? 'Autopilot altitude hold' : flightMode ? `${flightMode[0]!.toUpperCase()}${flightMode.slice(1)} mode` : null}
          autopilot={autoFlight ? autopilotInfo : null} config={config} timeScale={timeScale} onTimeScale={setTimeScale} timeToTargetS={climbing && estimate ? estimate.seconds : null} massT={massT} onMass={setMassT} trueAirspeedMps={settings.wind.airspeedMps} sectionCl={flightCl} onReset={restartFlight} />}
        <div className="viewport-footer"><div><span className="illustrative-badge cfd-badge"><Cpu size={12} /> 2D NAVIER–STOKES · LATTICE BOLTZMANN</span><span className="footer-detail experiment-readout">AOA {body.pitchable ? `${settings.angleOfAttackDeg.toFixed(1)}°` : '—'} <i>·</i> {Math.round(settings.wind.airspeedMps * 3.6)} km/h <i>·</i> {resolution} grid</span></div><span className="creator-credit">Shandy Putra (2026)</span></div>
      </section>

      <aside className="right-sidebar">
        <div className="right-heading"><span>EXPERIMENT</span><span className="experiment-id">WL-001</span></div>
        <Panel title="FLOW ANALYSIS" icon={<Sparkles size={13} />} className="insight-panel" help="What the air is doing right now, in plain words. It watches where air breaks away from the surface, whether swirls are shedding, and how the forces change.">
          <ul className="insight-list">{insights.map(item => <li key={item.id} className={`tone-${item.tone}`}><span className="insight-icon"><InsightIcon tone={item.tone} size={14} /></span><div><b>{item.title}</b><p>{item.detail}</p>{item.numbers && <small className="insight-numbers">{item.numbers}</small>}</div></li>)}</ul>
          {stats?.suction && stats.settled && <SurfaceBar separation={stats.suction.separation} />}
        </Panel>
        <Panel title="RESULTS" icon={<Gauge size={13} />} badge={<span className={`result-source ${stats?.settled ? 'is-live' : ''}`}>{stats?.settled ? 'TIME-AVERAGED' : 'SETTLING'}</span>}>
          <div className="result-grid">
            <Result label="DRAG COEFF · Cd" value={results?.cd} digits={3} />
            <Result label="LIFT COEFF · Cl" value={results?.cl} digits={3} />
            <Result label="DRAG / SPAN" value={results?.dragPerSpan} unit="N/m" digits={1} />
            <Result label={model.metadata.hasGround ? 'DOWNFORCE / SPAN' : 'LIFT / SPAN'} value={results ? (model.metadata.hasGround ? -results.liftPerSpan : results.liftPerSpan) : undefined} unit="N/m" digits={1} />
          </div>
          <div className="spark-wrap"><div className="spark-head"><span><i className="key-cd" /> Cd</span><span><i className="key-cl" /> Cl</span><span>last {telemetry ? Math.round(telemetry.historyCd.length * 10).toLocaleString() : 0} steps</span></div>{telemetry && <Sparkline cd={telemetry.historyCd} cl={telemetry.historyCl} />}</div>
          <div className="metric-list">
            {body.family === 'airfoil' && <Metric label="Lift-to-drag ratio" value={results && Math.abs(results.cd) > 1e-4 ? (results.cl / results.cd).toFixed(1) : '—'} />}
            <Metric label="Strouhal number" value={stats?.strouhal ? stats.strouhal.toFixed(3) : stats?.settled ? 'no shedding' : '—'} />
            <Metric label="Lift fluctuation (rms)" value={stats ? stats.clStd.toFixed(3) : '—'} />
            <Metric label="Tunnel blockage" value={stats ? `${(stats.blockage * 100).toFixed(0)}%` : '—'} />
            <Metric label={`Reference length (${body.forceLengthLabel})`} value={`${forceLengthM.toFixed(2)} m`} />
          </div>
          <div className="results-foot"><Info size={12} /> <span>Forces are measured from the simulated air. The simulation runs slower, smaller air than a real full-size wing or car (Re<sub>sim</sub>), so real drag is usually lower and stalls come later.{model.metadata.hasGround ? sideRelief ? ' Side relief is on: an approximation lets air "escape sideways"; its effect on lift and drag varies by shape, and a 2D slice still reads more drag and lift than a real car.' : ' Side relief is off: in a flat 2D slice no air can escape sideways, so drag and lift are much higher than a real car.' : ''}</span></div>
        </Panel>
        <Panel title="SOLVER" icon={<Cpu size={13} />} help="The simulator solves how air moves on a grid of cells (lattice Boltzmann method) with a turbulence model for small swirls, smooth curved walls, and open edges that let air leave cleanly. Smoke and colour fields only change what you see, not the physics.">
          <Select label="Smoke" value={smoke} options={smokeOptions} onChange={setSmoke} />
          <Select label="Field" value={display} options={fieldOptions} onChange={setDisplay} />
          {smoke !== 'none' && <Range label="Smoke wands" value={smokeLines} min={6} max={60} step={1} unit="lines" onChange={setSmokeLines} display={String(smokeLines)} />}
          <Select label="Grid" value={resolution} options={(['low', 'medium', 'high'] as const).map(r => ({ value: r, label: `${r[0]!.toUpperCase()}${r.slice(1)} · ${body.family === 'airfoil' || body.family === 'plate' ? `${RESOLUTION_BASE[r]} cells/chord` : `${FRONTAL_CELLS[r]} cells tall`}` }))} onChange={setResolution} />
          <Select label="Reynolds number" value={reMode} options={[{ value: 'auto', label: 'Match real air' }, { value: 'manual', label: 'Set manually' }] as const} onChange={setReMode} />
          {reMode === 'manual'
            ? <Range label="Simulated Reynolds number" value={Math.log10(Math.min(simReynolds, maxRe))} min={Math.log10(30)} max={Math.log10(maxRe)} step={0.01} unit="" display={Math.min(simReynolds, maxRe).toLocaleString()} onChange={v => setSimReynolds(reSlider(v))} help={`Re the lattice actually solves. Limited to ${maxRe.toLocaleString()} on this grid for stability; a finer grid allows more.`} />
            : <p className="panel-note re-note">Simulating Re <b>{effectiveRe.toLocaleString()}</b>{reCapped ? <> — real air here is Re {re.toExponential(1)}, more than this grid can resolve ({maxRe.toLocaleString()} max), so the flow uses the grid limit. Make the model slower, smaller or the air thinner/warmer to see Re drop below it.</> : <> — the real Reynolds number for this speed, size, temperature and pressure.</>}</p>}
          <div className="button-row"><button className="subtle-button" onClick={() => setResetKey(k => k + 1)}><RotateCcw size={13} /> Restart flow</button><button className="subtle-button" onClick={() => setClearKey(k => k + 1)}><Eraser size={13} /> Clear injectors</button></div>
        </Panel>
        <Panel title="AIR & SCALE" icon={<Wind size={13} />}>
          <Range label="Airspeed" value={Math.round(settings.wind.airspeedMps * 3.6)} min={10} max={900} step={5} unit="km/h" onChange={v => updateWind('airspeedMps', v / 3.6)} display={`${Math.round(settings.wind.airspeedMps * 3.6)}`} help={`${settings.wind.airspeedMps.toFixed(1)} m/s. Up to 900 km/h (airliner cruise). Above about 370 km/h (Mach 0.3) real air compresses, which this solver does not model.`} />
          <div className="two-inputs">
            {flightActive ? <div className="isa-readout"><span>Temperature <b>{airTemperatureC.toFixed(1)} °C</b></span><span>Static pressure <b>{(airPressurePa / 1000).toFixed(1)} kPa</b></span><small>Set by altitude (standard atmosphere) while the flight simulation is on.</small></div> : <>
            <NumberField label="Temperature" value={settings.wind.temperatureC} unit="°C" min={-80} max={150} decimals={1} onCommit={v => updateWind('temperatureC', v)} help="Changes air density (ideal gas) and viscosity (Sutherland's law), and so the Reynolds number, Mach number and forces." />
            <NumberField label="Static pressure" value={settings.wind.pressurePa / 1000} unit="kPa" min={1} max={500} decimals={3} onCommit={v => updateWind('pressurePa', v * 1000)} help="Changes air density, and so the Reynolds number and forces. Sea level is 101.325 kPa; ~26.5 kPa at 10 km altitude." /></>}
          </div>
          <Range label={`Reference length (${body.family === 'vehicle' ? 'car length' : body.family === 'airfoil' ? 'chord' : body.forceLengthLabel})`} value={settings.wind.characteristicLengthM} min={0.1} max={8} step={0.1} unit="m" onChange={v => updateWind('characteristicLengthM', v)} display={settings.wind.characteristicLengthM.toFixed(1)} />
          <div className="metric-list">
            <Metric label="Air density (ideal gas)" value={Number.isFinite(airDensity) ? `${airDensity.toFixed(3)} kg/m³` : 'N/A'} />
            <Metric label="Viscosity (Sutherland)" value={Number.isFinite(airViscosity) ? `${(airViscosity * 1e5).toFixed(3)}×10⁻⁵ Pa·s` : 'N/A'} />
            <Metric label="Dynamic pressure" value={Number.isFinite(qInf) ? `${qInf.toFixed(1)} Pa` : 'N/A'} />
            <Metric label="Physical Reynolds" value={Number.isFinite(re) ? re.toExponential(2) : 'N/A'} />
            <Metric label="Mach number" value={Number.isFinite(mach) ? mach.toFixed(3) : 'N/A'} />
          </div>
          {Number.isFinite(mach) && mach > 0.3 && <p className="panel-note warn-note">Mach {mach.toFixed(2)} is above 0.3: real air would compress noticeably, which this incompressible solver does not model.</p>}
        </Panel>
        {RUNNING_LOCALLY && model.kind === 'aircraft-wing' && <Panel title="OPENFOAM CROSS-CHECK" icon={<Radio size={13} />} className="solver-panel" help="Optional check with OpenFOAM, a professional CFD program, on a NACA 0012 wing at full-size conditions. It needs OpenFOAM installed and the local API running (npm run dev:all).">
          <div className="solver-status"><span className={solverAvailable ? 'status-dot' : 'solver-neutral'} /> <span>{solverJob?.status ?? (solverAvailable ? 'Ready' : 'Unavailable')}</span><span className="local-chip">LOCAL</span></div>
          <div className="solver-runtime-note" role="status">{solverJob?.message ?? solverMessage}</div>
          <button className="run-solver" disabled={!solverAvailable || solverBusy} onClick={runSolver}>{solverBusy ? <Activity size={13} /> : <Play size={13} fill="currentColor" />}{solverBusy ? 'Running OpenFOAM…' : 'Run NACA 0012 in OpenFOAM'}</button>
          {solverJob?.convergenceHistory?.length ? <div className="solver-convergence" aria-live="polite"><span>FINAL MAX RESIDUAL</span><b>{Math.max(...solverJob.convergenceHistory.slice(-20)).toExponential(2)}</b><small>{solverJob.convergenceMessage}</small></div> : null}
          {solverResultCurrent && solverJob?.results && <div className="result-grid solver-results"><Result label="OPENFOAM Cd" value={solverJob.results.dragCoefficient} digits={4} /><Result label="OPENFOAM Cl" value={solverJob.results.liftCoefficient} digits={4} /></div>}
          {solverJob?.status === 'Completed' && solverJob.flowField && <>
            <div className="solver-field-toolbar"><span>{fieldQuantity === 'velocity' ? 'Velocity magnitude · m/s' : 'Gauge pressure · Pa'}</span><div><button className={fieldQuantity === 'velocity' ? 'active' : ''} onClick={() => setFieldQuantity('velocity')}>U</button><button className={fieldQuantity === 'pressure' ? 'active' : ''} onClick={() => setFieldQuantity('pressure')}>p</button></div></div>
            <SolverFieldPreview field={solverJob.flowField} quantity={fieldQuantity} />
          </>}
        </Panel>}
        <div className="right-foot"><span><Sun size={12} /> {settings.wind.temperatureC.toFixed(0)}°C · {Number.isFinite(airDensity) ? `${airDensity.toFixed(3)} kg/m³` : 'air N/A'}</span><span>v0.5.0</span></div>
      </aside>
    </div>
  </main>
}

/** Chord-wise strip showing where the suction-side flow is attached and where it has reversed. */
function SurfaceBar({ separation }: { separation: number | null }) {
  const attached = separation === null ? 100 : Math.round(separation * 100)
  return <div className="surface-bar" title="Suction-side boundary layer from leading edge (left) to trailing edge (right)">
    <div className="surface-bar-track"><i className="attached" style={{ width: `${attached}%` }} /><i className="separated" style={{ width: `${100 - attached}%` }} /></div>
    <div className="surface-bar-labels"><span>LE</span><span>{separation === null ? 'attached to trailing edge' : `separates at x/c ${separation.toFixed(2)}`}</span><span>TE</span></div>
  </div>
}

function WelcomePage({ onStart }: { onStart: () => void }) {
  const art = useRef<HTMLDivElement>(null)
  return <main className="welcome-page">
    <header className="welcome-top"><span className="brand-mark"><BrandMark size={20} /></span><span className="brand-text"><span className="welcome-brand">WindlyLab</span><span className="brand-by">By Shandy Putra</span></span></header>
    <section className="welcome-hero">
      <WelcomeFlow art={art} />
      <div className="welcome-shade" aria-hidden="true" />
      <div className="welcome-content">
        <div className="welcome-copy">
          <h1>See the air move.</h1>
          <div className="welcome-actions"><button className="start-button" onClick={onStart}>Open wind tunnel <ArrowRight size={16} /></button><a className="welcome-more" href="#about">What's inside <ChevronDown size={14} /></a></div>
          <div className="welcome-legend" aria-hidden="true"><span><i className="lg-slat" /> Slat</span><span><i className="lg-main" /> Main wing</span><span><i className="lg-flap" /> Double-slotted flap</span></div>
          <p className="device-note"><span className="device-icons" aria-hidden="true"><Laptop size={14} /><Tablet size={13} /></span><span>Using a <em>laptop</em> or <em>tablet</em> is recommended for the best experience</span></p>
        </div>
        <div className="welcome-art" ref={art} aria-hidden="true" />
      </div>
    </section>

    <section className="welcome-info" id="about" aria-labelledby="about-title">
      <BlueprintBackdrop />
      <div className="welcome-info-inner">
        <div className="info-intro">
          <p className="info-eyebrow">ABOUT WINDLYLAB</p>
          <h2 id="about-title">A wind tunnel that runs in your browser</h2>
          <p>WindlyLab solves real airflow around wings, cars and simple shapes while you watch. A lattice Boltzmann Navier–Stokes solver with a turbulence model and curved walls runs on several CPU cores right on this page, so every change you make (angle, speed, slats, flaps) re-solves the air instead of replaying an animation.</p>
        </div>

        <h3 className="info-heading">What you can do</h3>
        <div className="info-grid">
          <article><Cuboid size={16} /><h4>Test a model</h4><p>Twelve models: the airliner wing, six cars from an SUV to a time-attack racer, and five basic shapes (cube, cylinder, sphere, wedge, flat plate). Set the angle of attack, model scale, airspeed up to 900 km/h, temperature and pressure.</p></article>
          <article><Wind size={16} /><h4>See the flow</h4><p>Realistic smoke or streakline particles, with velocity or pressure (Cp) fields behind them. Click to add a smoke wand, hover to probe the speed and pressure at any point, zoom in on the wing.</p></article>
          <article><Activity size={16} /><h4>Read the results</h4><p>Drag and lift coefficients, lift-to-drag ratio, vortex-shedding frequency and tunnel blockage, plus plain-English flow analysis that tells you when air peels off, a wing stalls or swirls start shedding.</p></article>
          <article><Plane size={16} /><h4>Shape a high-lift wing</h4><p>Deploy the slat and double-slotted flaps and watch air squeeze through the real slots between them. The rear wing on the race cars tilts the same way.</p></article>
          <article><Gauge size={16} /><h4>Fly it</h4><p>The flight panel turns the wing's lift into a whole airliner at altitude: standard-atmosphere air, true and equivalent airspeed, Mach, lift against weight and an altitude trace, with time sped up to 60×.</p></article>
          <article><Cpu size={16} /><h4>Choose the detail</h4><p>Low, Medium or High grid; Reynolds number matched to real air or set by hand; side relief that lets air escape around a car's sides as it would in 3D.</p></article>
        </div>

        <h3 className="info-heading">Flight modes</h3>
        <div className="info-modes">
          <div><b>Cruise</b><span>Levels off where the aircraft is and holds it.</span></div>
          <div><b>Climb · Descend</b><span>From a start altitude, up or down by the amount you choose at your rate of climb or descent, with the time to get there. The angle, slats and flaps adjust themselves and level off exactly on the target.</span></div>
          <div><b>Autopilot · altitude hold</b><span>Its own mode: enter the altitude to hold and it flies there and stays.</span></div>
          <div><b>By hand</b><span>Move the angle, slat and flap sliders yourself; any automatic mode hands back control.</span></div>
        </div>

        <p className="info-note">Good to know: the tunnel is two-dimensional (a slice through the wing or car) and simulates small-scale air (a low Reynolds number), so trends and flow patterns are right but a full-size wing makes more lift than these numbers.</p>
        <div className="info-cta"><button className="start-button" onClick={onStart}>Open wind tunnel <ArrowRight size={16} /></button></div>
      </div>
      <footer className="welcome-footer"><span>WINDLYLAB · AERODYNAMICS LAB</span><span>Shandy Putra (2026)</span></footer>
    </section>
  </main>
}

function Result({ label, value, unit, digits = 2 }: { label: string; value?: number; unit?: string; digits?: number }) {
  const shown = value === undefined || !Number.isFinite(value) ? undefined : Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value
  return <div className="result-cell"><span>{label}</span><b>{shown === undefined ? '—' : shown.toFixed(digits)}{shown !== undefined && unit && <small> {unit}</small>}</b></div>
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-row"><span>{label}</span><b>{value}</b></div> }
