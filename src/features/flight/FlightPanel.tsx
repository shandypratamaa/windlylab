import { Gauge, Mountain, Plane, RotateCcw, Scale } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { equilibriumAltitude, equivalentAirspeed, finiteWingLift, finiteWingLiftSlope, isa, type FlightState } from '../../physics/atmosphere'
import type { ConfigName } from './flight-plan'

export const AIRCRAFT = { wingAreaM2: 360, aspectRatio: 9.5 }

interface Props {
  enabled: boolean
  onToggle: (enabled: boolean) => void
  initialAltitudeM: number
  onInitialAltitude: (m: number) => void
  flight: FlightState
  history: number[]
  /** Altitude the autopilot flies to (the flight preset's target, or where it was engaged). */
  holdTargetM: number
  holdAltitude: boolean
  onHoldAltitude: (on: boolean) => void
  /** Altitude the autopilot holds (asked for when it is engaged). */
  holdAltitudeM: number
  onHoldAltitudeM: (m: number) => void
  /** Warning under the initial altitude slider (during a climb/descent it is also the start altitude). */
  initialAltitudeWarning: string | null
  /** Stall or stall-warning message, if any. */
  stallWarning: { level: 'stall' | 'warning'; text: string } | null
  /** Name of the automatic flight mode flying the wing, or null when flying by hand. */
  modeLabel: string | null
  /** Live autopilot state while it is flying, or null when it is off. */
  autopilot: { saturated: -1 | 0 | 1; commandedRateMps: number } | null
  /** Wing configuration currently set (null for hand-set slat/flap angles). */
  config: ConfigName | null
  /** Flight time runs this many times faster than real time. */
  timeScale: number
  onTimeScale: (scale: number) => void
  /** Flight seconds a climb/descent needs to reach its target (null when none is active or it can't). */
  timeToTargetS: number | null
  massT: number
  onMass: (t: number) => void
  trueAirspeedMps: number
  /** Section Cl the flight uses: the lift table (corrected by the CFD) for a known configuration, else the settled CFD lift. */
  sectionCl: number | null
  onReset: () => void
}

const fmtTime = (sec: number) => sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round(sec % 3600 / 60)} min` : sec >= 60 ? `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s` : `${Math.max(1, Math.round(sec))} s`
const fmt = (v: number, d = 0) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

function MiniRange({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  return <label className="flight-range"><span><span>{label}</span><b>{display}</b></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ '--range-pct': `${(value - min) * 100 / (max - min)}%` } as CSSProperties} />
  </label>
}

/**
 * Asks which altitude the autopilot should hold, with one-click choices for the
 * current and the initial altitude.
 */
export function HoldAltitudeField({ value, onChange, initialAltitudeM, currentAltitudeM }: { value: number; onChange: (m: number) => void; initialAltitudeM: number; currentAltitudeM: number }) {
  const [text, setText] = useState(String(Math.round(value)))
  useEffect(() => { setText(String(Math.round(value))) }, [value])
  const commit = (raw: string) => {
    const m = Number(raw.replace(/[^0-9.]/g, ''))
    if (raw.trim() !== '' && Number.isFinite(m)) onChange(Math.max(0, Math.min(13000, Math.round(m))))
    else setText(String(Math.round(value)))
  }
  return <div className="hold-field">
    <label><span>Hold altitude</span>
      <span className="hold-input"><input type="text" inputMode="numeric" aria-label="Altitude for the autopilot to hold, metres" value={text} onChange={e => setText(e.target.value)} onBlur={e => commit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value) }} /> m</span>
    </label>
    <div className="hold-choices">
      <button type="button" className="subtle-button" onClick={() => onChange(Math.round(currentAltitudeM))}>Now · {fmt(currentAltitudeM)} m</button>
      <button type="button" className="subtle-button" onClick={() => onChange(initialAltitudeM)}>Initial · {fmt(initialAltitudeM)} m</button>
    </div>
  </div>
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'good' }) {
  return <div className="flight-row"><span>{label}</span><b className={tone ? `tone-text-${tone}` : ''}>{value}</b></div>
}

/** Altitude history as a small area chart, with the equilibrium altitude dashed. */
function AltitudeTrace({ history, target }: { history: number[]; target: number | null }) {
  if (history.length < 2) return <div className="flight-trace-empty">Altitude trace starts when lift data is ready</div>
  const values = target === null ? history : [...history, target]
  let lo = Math.min(...values); let hi = Math.max(...values)
  if (hi - lo < 200) { const mid = (hi + lo) / 2; lo = mid - 100; hi = mid + 100 }
  const y = (v: number) => 46 - (v - lo) / (hi - lo) * 42
  const pts = history.map((v, i) => `${(i / (history.length - 1) * 200).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return <svg className="flight-trace" viewBox="0 0 200 50" preserveAspectRatio="none" role="img" aria-label="Altitude over time">
    {target !== null && <line x1="0" x2="200" y1={y(target)} y2={y(target)} className="flight-target" />}
    <polygon points={`0,50 ${pts} 200,50`} className="flight-area" /><polyline points={pts} className="flight-line" />
  </svg>
}

export default function FlightPanel({ enabled, onToggle, initialAltitudeM, onInitialAltitude, flight, history, stallWarning, holdTargetM, holdAltitude, onHoldAltitude, holdAltitudeM, onHoldAltitudeM, initialAltitudeWarning, modeLabel, autopilot, config, timeScale, onTimeScale, timeToTargetS, massT, onMass, trueAirspeedMps, sectionCl, onReset }: Props) {
  const air = isa(flight.altitudeM)
  const q = 0.5 * air.densityKgM3 * trueAirspeedMps ** 2
  const mach = trueAirspeedMps / air.speedOfSoundMps
  const weightN = massT * 1000 * 9.80665
  const slope = finiteWingLiftSlope(AIRCRAFT.aspectRatio)
  const inputs = sectionCl === null ? null : { trueAirspeedMps, sectionCl, massKg: massT * 1000, wingAreaM2: AIRCRAFT.wingAreaM2, aspectRatio: AIRCRAFT.aspectRatio }
  // Climbing makes the air meet the wing from above, lowering its angle by w/V.
  const wingCl = sectionCl === null ? null : finiteWingLift(sectionCl, AIRCRAFT.aspectRatio) - slope * flight.climbRateMps / Math.max(1, trueAirspeedMps)
  const liftN = wingCl === null ? null : q * AIRCRAFT.wingAreaM2 * wingCl
  const neededCl = weightN / (q * AIRCRAFT.wingAreaM2)
  const balance = liftN === null ? null : liftN / weightN
  const flying = autopilot !== null
  const saturated = flying && autopilot.saturated !== 0
  // Where it ends up: the autopilot's target, or (hands-off) where lift = weight for this wing setting.
  const target = flying ? (saturated ? null : holdTargetM) : inputs ? equilibriumAltitude(inputs) : null
  const climb = flight.climbRateMps
  const away = Math.abs(flight.altitudeM - holdTargetM) >= 3
  const status = sectionCl === null ? 'Waiting for the CFD lift to settle'
    : flight.altitudeM <= 0.5 && climb <= 0.05 ? 'On the ground — not enough lift to fly'
      : flying && !away && Math.abs(climb) < 0.2 ? `Level at ${fmt(holdTargetM)} m`
        : !flying && Math.abs(climb) < 0.2 && balance !== null && Math.abs(balance - 1) < 0.02 ? 'Level flight — lift equals weight'
          : `${climb > 0 ? 'Climbing' : 'Descending'} ${fmt(Math.abs(climb), 1)} m/s${flying ? ` → ${fmt(holdTargetM)} m` : ''}`
  const autopilotText = !flying ? 'starting' : autopilot.saturated === 1 ? 'at full lift' : autopilot.saturated === -1 ? 'at minimum lift' : config ?? 'wing'

  return <section className={`flight-panel ${enabled ? 'is-open' : ''}`} aria-label="Flight simulation">
    <header className="flight-head">
      <label className="flight-switch"><input type="checkbox" role="switch" aria-label="Flight simulation" checked={enabled} onChange={e => onToggle(e.target.checked)} /><span className="toggle-switch" aria-hidden="true" /><span><Plane size={13} /> Flight simulation</span></label>
      <span className="flight-sub">{enabled ? 'An airliner (360 m² wing, aspect ratio 9.5) flying with this wing section at your airspeed' : 'Optional: see what this wing does for a whole airliner at altitude'}</span>
      {enabled && <button type="button" className="subtle-button" onClick={onReset} title="Return to the initial altitude"><RotateCcw size={13} /> Restart flight</button>}
    </header>
    {enabled && <div className="flight-grid">
      <article className="flight-card">
        <h3><Mountain size={13} /> Altitude & air</h3>
        <MiniRange label="Initial altitude" value={initialAltitudeM} min={0} max={13000} step={100} display={`${fmt(initialAltitudeM)} m`} onChange={onInitialAltitude} />
        {initialAltitudeWarning && <p className="flight-note flight-warn">{initialAltitudeWarning}</p>}
        <Row label="Now" value={`${fmt(flight.altitudeM)} m · ${fmt(flight.altitudeM * 3.28084)} ft`} />
        <Row label="Temperature" value={`${fmt(air.temperatureC, 1)} °C`} />
        <Row label="Pressure" value={`${fmt(air.pressurePa / 1000, 1)} kPa`} />
        <Row label="Density" value={`${air.densityKgM3.toFixed(3)} kg/m³ (${Math.round(air.densityKgM3 / 1.225 * 100)}%)`} />
      </article>
      <article className="flight-card">
        <h3><Gauge size={13} /> Speed</h3>
        <Row label="True airspeed" value={`${fmt(trueAirspeedMps * 3.6)} km/h`} />
        <Row label="Equivalent airspeed" value={`${fmt(equivalentAirspeed(trueAirspeedMps, air.densityKgM3) * 3.6)} km/h`} />
        <Row label="Mach" value={mach.toFixed(2)} tone={mach > 0.7 ? 'warn' : undefined} />
        <Row label="Dynamic pressure" value={`${fmt(q / 1000, 2)} kPa`} />
        <p className="flight-note">{mach > 0.7 ? 'Transonic: a real wing would form shock waves here, which the incompressible solver does not model.' : mach > 0.3 ? 'Above Mach 0.3 air compresses noticeably; treat forces as approximate.' : 'Thin air at altitude needs more true speed for the same lift.'}</p>
      </article>
      <article className="flight-card">
        <h3><Scale size={13} /> Lift vs weight</h3>
        <MiniRange label="Aircraft mass" value={massT} min={60} max={380} step={5} display={`${fmt(massT)} t`} onChange={onMass} />
        <Row label="Wing lift" value={liftN === null ? '—' : `${fmt(liftN / 1000)} kN`} />
        <Row label="Weight" value={`${fmt(weightN / 1000)} kN`} />
        <Row label="Lift / weight" value={balance === null ? '—' : `${Math.round(balance * 100)}%`} tone={balance === null ? undefined : Math.abs(balance - 1) < 0.05 ? 'good' : 'warn'} />
        <Row label="Wing CL now / needed" value={wingCl === null ? '—' : `${wingCl.toFixed(2)} / ${neededCl.toFixed(2)}`} />
      </article>
      <article className="flight-card flight-card-wide">
        {stallWarning && <p className={`flight-stall flight-stall-${stallWarning.level}`} role="alert">{stallWarning.text}</p>}
        <h3><Plane size={13} /> Flight path <span className="flight-timescale">time ×{timeScale}</span></h3>
        <MiniRange label="Time speed" value={timeScale} min={1} max={60} step={1} display={timeScale === 1 ? 'real time' : `×${timeScale}`} onChange={onTimeScale} />
        <p className="flight-note">{timeToTargetS !== null
          ? `The climb/descent takes ${fmtTime(timeToTargetS)} of flight: ${fmtTime(timeToTargetS / timeScale)} on screen at ×${timeScale}. Changing the speed changes only how long you wait, not the flight itself.`
          : 'How much faster than real time the flight plays. It changes how long you wait on screen, not the flight itself (rates, altitudes and the flight time to a target stay the same).'}</p>
        <label className="flight-switch flight-hold"><input type="checkbox" role="switch" checked={holdAltitude} onChange={e => onHoldAltitude(e.target.checked)} /><span className="toggle-switch" aria-hidden="true" /><span>Autopilot (altitude hold)</span></label>
        {holdAltitude && <HoldAltitudeField value={holdAltitudeM} onChange={onHoldAltitudeM} initialAltitudeM={initialAltitudeM} currentAltitudeM={flight.altitudeM} />}
        <AltitudeTrace history={history} target={target} />
        <Row label="Flying" value={modeLabel ? `${modeLabel} · ${autopilotText}` : 'by hand'} tone={saturated ? 'warn' : undefined} />
        <Row label="Status" value={status} tone={sectionCl === null ? undefined : Math.abs(climb) < 0.2 ? 'good' : undefined} />
        <Row label="Settles at" value={target !== null ? `${fmt(target)} m` : sectionCl === null ? '—' : wingCl !== null && wingCl * 0.5 * isa(0).densityKgM3 * trueAirspeedMps ** 2 * AIRCRAFT.wingAreaM2 < weightN ? 'too little lift even at sea level' : 'still climbing at 20 km'} tone={target === null && sectionCl !== null ? 'warn' : undefined} />
        <p className="flight-note">{sectionCl === null ? 'The flight starts once the tunnel flow has settled.'
          : saturated ? `The autopilot has ${autopilot!.saturated === 1 ? 'slats, flaps and angle at their maximum lift' : 'the wing at its minimum lift'} and still can't fly the rate asked, so it ${autopilot!.saturated === 1 ? 'climbs slower or sinks' : 'descends slower'}. Fly faster, lighten the aircraft, or ask for less. The tunnel simulates small-scale air (low Reynolds number), which makes less lift than a full-size wing.`
            : flying ? 'The angle of attack, slat and flaps are set every moment so lift gives the vertical speed wanted, easing off over the last ~100 m to level off exactly on the target.'
              : "Hands-off: the wing stays as set. Climbing lowers the wing's angle to the oncoming air, so the aircraft drifts to where lift equals weight."} Lift is the solver's section lift (from its measured lift curves, corrected live by the CFD) with a lifting-line correction for a finite wing.</p>
      </article>
    </div>}
  </section>
}
