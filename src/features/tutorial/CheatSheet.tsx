import { BookOpen, X } from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { finiteWingLift, isa } from '../../physics/atmosphere.ts'
import type { CfdResolution } from '../../physics/lbm/cfd-simulation.ts'
import { liftModel, type ConfigName } from '../flight/flight-plan.ts'

/** A wing setting the tunnel can be set to from a scenario row. */
export interface ScenarioSetting { slat: number; flap: number; aoa: number }
export interface ScenarioApply extends ScenarioSetting {
  label: string
  /** Change to this setting a few seconds later (to watch lift fall). */
  then?: ScenarioSetting
  /** Open the flight panel at an airspeed that gives more lift than weight. */
  climb?: boolean
}
interface Props { onClose: () => void; resolution: CfdResolution; onApply: (a: ScenarioApply) => void }

const WING_AREA = 360
const ASPECT = 9.5

/** Every symbol and term used in WindlyLab, in plain words. */
const SYMBOLS: [string, string, string][] = [
  ['Cl', 'Lift coefficient', 'How good the wing section is at making lift, independent of speed and size. The letter is a lowercase L (C-ell), often misread as "C1". 0 = no lift; about 0.3–0.6 in cruise; above 1 needs slats and flaps.'],
  ['CL', 'Wing lift coefficient', 'The same for the whole 3D wing (capital L). It is a bit lower than the 2D section Cl because air leaks round the wingtips. The flight panel uses CL.'],
  ['Cd', 'Drag coefficient', 'How strongly the shape resists the air. A streamlined wing is around 0.01–0.1 here; a blunt cube above 1.'],
  ['L/D', 'Lift-to-drag ratio', 'Lift for every unit of drag. Higher is more efficient: airliners about 15–20 in 3D, gliders 40+.'],
  ['α (alpha), AoA', 'Angle of attack', 'How far the wing is tilted nose-up into the oncoming air, in degrees.'],
  ['δf (delta f)', 'Flap deflection', 'How far the flaps are lowered, in degrees.'],
  ['V∞, TAS', 'Free stream, true airspeed', 'The speed of the undisturbed air relative to the model (or of the aircraft through the air).'],
  ['EAS', 'Equivalent airspeed', 'The sea-level speed that would give the same dynamic pressure; what the pilot\'s airspeed gauge effectively reads.'],
  ['q', 'Dynamic pressure', 'The "push" of moving air: ½ × density × speed². Forces = coefficient × q × area.'],
  ['ρ (rho)', 'Air density', 'Mass of air per cubic metre. About 1.225 kg/m³ at sea level, 0.41 at 11 km.'],
  ['μ (mu)', 'Viscosity', 'How sticky the air is. Rises slightly with temperature (Sutherland\'s law).'],
  ['Re', 'Reynolds number', 'Momentum vs stickiness: density × speed × size ÷ viscosity. Large Re (full-size aircraft, ~10⁷) keeps air attached longer; the simulation runs up to ~10⁴, like a small model.'],
  ['Ma, Mach', 'Mach number', 'Speed ÷ speed of sound. Above 0.3 real air compresses; above ~0.7 shock waves form (not simulated here).'],
  ['Cp', 'Pressure coefficient', 'Local pressure compared with the free stream. Negative (blue) pulls on the surface, positive (red) pushes; +1 is where the air stops at the nose.'],
  ['St', 'Strouhal number', 'How often swirls break off, scaled by size and speed. About 0.2 behind a cylinder.'],
  ['Cl rms', 'Lift fluctuation', 'How much the lift wobbles about its average. Large values mean buffet (shaking), typically near a stall.'],
  ['c', 'Chord', 'The wing\'s length from front (leading edge) to back (trailing edge). Positions are given as x/c: 0 at the nose, 1 at the tail.'],
  ['c/4', 'Quarter chord', 'The point a quarter of the way back, which the wing pivots about.'],
  ['ISA', 'International Standard Atmosphere', 'The agreed average temperature, pressure and density at each altitude.'],
  ['Blockage', 'Tunnel blockage', 'Share of the tunnel height the model fills. Above ~10% the walls exaggerate the forces.'],
  ['Flow-through', 'Tunnel flow-through', 'The time air takes to cross the whole tunnel; the solver waits about 1.2 of them after a fresh start before averaging.'],
  ['LBM', 'Lattice Boltzmann method', 'The way the simulation solves the air: tiny packets of air move and collide on a grid of cells.'],
  ['LES', 'Large-eddy simulation', 'Turbulence model: the grid resolves the big swirls and a formula handles the smallest ones.'],
]

const TERMS: [string, string][] = [
  ['Lift', 'The force pushing the wing up, at right angles to the oncoming air.'],
  ['Drag', 'The force pulling the model backwards, along the oncoming air.'],
  ['Downforce', 'Lift pointing down: what car wings make to press the tyres onto the road.'],
  ['Leading / trailing edge', 'The wing\'s front (rounded) and back (sharp) edges.'],
  ['Camber', 'How curved the wing is. A cambered wing makes lift even at 0°.'],
  ['Slat', 'A small wing piece that slides out of the leading edge, opening a slot. It lets the wing reach higher angles before stalling.'],
  ['Flap', 'Wing pieces that slide out of the trailing edge and droop, adding area and curve for much more lift (and drag) at low speed.'],
  ['Slot', 'The gap between wing pieces. Fast air from underneath flows through it over the next piece and keeps the air attached.'],
  ['Boundary layer', 'The thin layer of slow air right next to the surface.'],
  ['Separation', 'When the boundary layer can no longer follow the surface and breaks away, leaving swirling dead air.'],
  ['Stall', 'Separation over most of the wing\'s top: lift stops rising and drops, drag shoots up, the wing shakes.'],
  ['Vortex shedding', 'Swirls breaking off alternately from top and bottom (a Kármán street), which makes the force wobble.'],
  ['Wake', 'The disturbed, slower air behind the model.'],
  ['Settled / time-averaged', 'The results are averaged once the air has adjusted to the last change.'],
  ['Side relief (2.5D)', 'For cars: lets low-pressure air refill as it would from the sides of a real 3D car.'],
]

const CONTROLS: [string, string][] = [
  ['Welcome', 'Back to the start page.'],
  ['Pause / Resume (Space)', 'Freeze or continue the air.'],
  ['Restart flow (R)', 'Start the air again from rest (keeps your settings).'],
  ['Reset all', 'Put every setting back to the start.'],
  ['Tutorial · Cheat sheet', 'Reopen the guided tour or this page.'],
  ['Shapes · Cars · Aircraft', 'Model groups; then pick a model from the list.'],
  ['Airfoil', 'Wing cross-section: NACA 0012 (symmetric) or 2412 (cambered).'],
  ['Angle of attack', 'Tilt the model nose-up or nose-down (−10° to 25°).'],
  ['Model scale', 'Resize the model in the tunnel; watch the blockage.'],
  ['Cruise · Climb · Descend', 'Flight modes that set the angle, slat and flaps for you; click the active one again to fly by hand.'],
  ['Start altitude · Altitude to gain/lose · Rate', 'Climb/descent plan: where it starts, how far, how fast (m/s and ft/min).'],
  ['Autopilot (altitude hold)', 'Flies to and holds an altitude you enter.'],
  ['Slat · Flaps · Flap type', 'Move the high-lift devices by hand; single- or double-slotted flaps.'],
  ['Use High grid', 'Switch to the finest grid so the slots are resolved.'],
  ['Zoom · Focus · Whole tunnel · Full screen', 'Change the view. Drag to pan, scroll to zoom.'],
  ['Click / hover in the tunnel', 'Add a smoke wand / read the local speed and pressure.'],
  ['Smoke · Field · Smoke wands', 'How the air is drawn; colour field behind it; number of smoke lines.'],
  ['Grid', 'Low, Medium or High detail (faster vs finer).'],
  ['Reynolds number', 'Match real air (up to the grid limit) or set it by hand.'],
  ['Clear injectors', 'Remove the smoke wands you added.'],
  ['Airspeed · Temperature · Pressure · Reference length', 'The air and the model\'s real size.'],
  ['Flight simulation', 'Whole-airliner panel: altitude, speed, lift vs weight, flight path, time speed.'],
  ['? buttons', 'Short explanation of each panel.'],
  ['OpenFOAM cross-check', 'Optional external CFD check; only shown when WindlyLab runs on your own computer with OpenFOAM installed.'],
]

const fmt = (v: number, d = 0) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

type ComboRow = [string, string, string, ScenarioApply?]
/** Small table of slat/flap/angle combinations (setting, angle, section Cl), each with a one-click Apply. */
function Combos({ rows, onApply }: { rows: ComboRow[]; onApply: (a: ScenarioApply) => void }) {
  return <div className="cheat-combos">
    <div className="cheat-combos-head"><span>Slat / flaps</span><span>Angle α</span><span>Cl</span><span /></div>
    {rows.map(([setting, aoa, cl, apply]) => <div key={setting}><span>{setting}</span><span>{aoa}</span><span>{cl}</span>
      <span>{apply && <button type="button" className="cheat-apply" title={`Set the tunnel wing to ${apply.label} and close the cheat sheet`} onClick={() => onApply(apply)}>Apply</button>}</span></div>)}
  </div>
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="cheat-section"><h3>{title}</h3>{children}</section>
}

/**
 * One-page reference: symbols and terms, flight scenarios with this simulator's
 * measured numbers, a hold-lift calculator, temperature and pressure, and every control.
 */
export default function CheatSheet({ onClose, resolution, onApply }: Props) {
  const model = useMemo(() => liftModel(resolution), [resolution])
  const line = (name: ConfigName) => model.find(l => l.name === name)!
  const clean = line('clean'); const takeOff = line('take-off flaps'); const landing = line('landing flaps')
  const clAt = (name: ConfigName, aoa: number) => { const l = line(name); return l.cl0 + l.slope * aoa }
  /** Highest whole degree the clean wing flies before the air starts breaking away. */
  const aoaHi = Math.floor(clean.aoaMax)

  // Hold-lift calculator.
  const [config, setConfig] = useState<ConfigName>('clean')
  const cfgLine = line(config)
  const [aoa, setAoa] = useState(5)
  const [altitude, setAltitude] = useState(3000)
  const [massT, setMassT] = useState(200)
  const sectionCl = clAt(config, aoa)
  const wingCl = finiteWingLift(sectionCl, ASPECT)
  const air = isa(altitude)
  const levelSpeed = wingCl > 0.02 ? Math.sqrt(2 * massT * 1000 * 9.80665 / (air.densityKgM3 * WING_AREA * wingCl)) : null
  const pastStall = aoa > cfgLine.aoaMax + 0.01

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const nav = [['symbols', 'Symbols'], ['scenarios', 'Scenarios'], ['hold-lift', 'Hold lift steady'], ['air', 'Temperature & pressure'], ['terms', 'Terms'], ['controls', 'Controls']]
  const rng = (v: number, min: number, max: number) => ({ '--range-pct': `${(v - min) * 100 / (max - min)}%` } as CSSProperties)
  return <div className="cheat-backdrop" role="dialog" aria-modal="true" aria-labelledby="cheat-title" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="cheat-sheet">
      <header className="cheat-head">
        <span className="cheat-icon"><BookOpen size={16} /></span>
        <div><h2 id="cheat-title">WindlyLab cheat sheet</h2><p>Every symbol, scenario and control on one page. Numbers come from this simulator ({resolution} grid).</p></div>
        <button type="button" className="icon-button" aria-label="Close the cheat sheet" onClick={onClose}><X size={16} /></button>
      </header>
      <nav className="cheat-nav">{nav.map(([id, label]) => <a key={id} href={`#${id}`} onClick={e => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>{label}</a>)}</nav>
      <div className="cheat-body">
        <Section id="symbols" title="Symbols">
          <div className="cheat-table">{SYMBOLS.map(([sym, name, text]) => <div key={sym} className="cheat-row"><b className="cheat-sym">{sym}</b><span><em>{name}</em> — {text}</span></div>)}</div>
        </Section>

        <Section id="scenarios" title="Scenarios">
          <p className="cheat-note">Angles below are for the simulated airliner wing (NACA 2412 with slat and double-slotted flap) on the {resolution} grid, at the Reynolds number the grid allows. A full-size wing makes more lift and stalls a few degrees later.</p>
          <div className="cheat-cards">
            <article className="tone-good"><h4>Generating lift</h4>
              <p><b>Looks like:</b> Cl above 0, smoke hugging both surfaces, "Smooth flow — the wing is working well".</p>
              <p><b>Get there:</b> clean wing at about 2–{fmt(Math.floor(clean.aoaMax))}° (Cl ≈ {fmt(clAt('clean', 2), 2)} to {fmt(clean.clMax, 2)}). Each degree adds about {fmt(clean.slope, 2)} of Cl.</p>
              <Combos onApply={onApply} rows={[
                ['Clean, gentle', '2°', fmt(clAt('clean', 2), 2), { label: 'clean, 2°', slat: 0, flap: 0, aoa: 2 }],
                ['Clean, working hard', `${aoaHi}°`, fmt(clAt('clean', aoaHi), 2), { label: `clean, ${aoaHi}°`, slat: 0, flap: 0, aoa: aoaHi }],
                ['Take-off 18° / 20°', '6°', fmt(clAt('take-off flaps', 6), 2), { label: 'take-off 18° / 20°, 6°', slat: 18, flap: 20, aoa: 6 }],
                ['Landing 20° / 30°', '6°', fmt(clAt('landing flaps', 6), 2), { label: 'landing 20° / 30°, 6°', slat: 20, flap: 30, aoa: 6 }],
              ]} /></article>
            <article className="tone-warn"><h4>Losing lift</h4>
              <p><b>Looks like:</b> Cl falling; in the flight panel lift below weight and "Descending".</p>
              <p><b>Causes:</b> less angle, less speed (lift ∝ speed², so 10% slower = 19% less lift), thinner air (higher, hotter), retracting slats/flaps, or going past the stall.</p>
              <Combos onApply={onApply} rows={[
                ['Clean', `${aoaHi}° → 2°`, `${fmt(clAt('clean', aoaHi), 2)} → ${fmt(clAt('clean', 2), 2)}`, { label: `clean, ${aoaHi}° then 2°`, slat: 0, flap: 0, aoa: aoaHi, then: { slat: 0, flap: 0, aoa: 2 } }],
                ['Take-off 18° / 20° → clean', `5°`, `${fmt(clAt('take-off flaps', 5), 2)} → ${fmt(clAt('clean', 5), 2)}`, { label: 'take-off 18° / 20° then clean, 5°', slat: 18, flap: 20, aoa: 5, then: { slat: 0, flap: 0, aoa: 5 } }],
                ['Landing 20° / 30° → take-off 18° / 20°', `5°`, `${fmt(clAt('landing flaps', 5), 2)} → ${fmt(clAt('take-off flaps', 5), 2)}`, { label: 'landing 20° / 30° then take-off 18° / 20°, 5°', slat: 20, flap: 30, aoa: 5, then: { slat: 18, flap: 20, aoa: 5 } }],
                ['Clean, past the stall', `${fmt(Math.ceil(clean.aoaMax) + 4)}°+`, 'drops, wobbles', { label: `clean, ${aoaHi}° then ${Math.ceil(clean.aoaMax) + 5}°`, slat: 0, flap: 0, aoa: aoaHi, then: { slat: 0, flap: 0, aoa: Math.ceil(clean.aoaMax) + 5 } }],
              ]} /></article>
            <article className="tone-good"><h4>Climbing</h4>
              <p><b>Looks like:</b> lift above weight in the flight panel, "Climbing … m/s", altitude trace rising.</p>
              <p><b>Get there:</b> more lift than weight at your speed: raise the angle, extend slats/flaps, or speed up. While climbing the wing meets the air from slightly above, so it needs a little extra angle to keep climbing. Climb mode sets all of this for a chosen rate.</p>
              <Combos onApply={onApply} rows={[
                ['Clean, fast climb (600–900 km/h)', `${fmt(Math.max(3, aoaHi - 2))}–${aoaHi}°`, `${fmt(clAt('clean', Math.max(3, aoaHi - 2)), 2)}–${fmt(clAt('clean', aoaHi), 2)}`, { label: `clean climb, ${Math.max(3, aoaHi - 1)}°`, slat: 0, flap: 0, aoa: Math.max(3, aoaHi - 1), climb: true }],
                ['Take-off 18° / 20°, after lift-off', `4–${fmt(Math.floor(takeOff.aoaMax))}°`, `${fmt(clAt('take-off flaps', 4), 2)}–${fmt(takeOff.clMax, 2)}`, { label: 'take-off 18° / 20° climb, 6°', slat: 18, flap: 20, aoa: 6, climb: true }],
                ['Landing 20° / 30°, go-around (more drag)', `3–${fmt(Math.floor(landing.aoaMax))}°`, `${fmt(clAt('landing flaps', 3), 2)}–${fmt(landing.clMax, 2)}`, { label: 'landing 20° / 30° go-around, 6°', slat: 20, flap: 30, aoa: 6, climb: true }],
              ]} /></article>
            <article className="tone-alert"><h4>Stalled</h4>
              <p><b>Looks like:</b> smoke tearing off the top in big swirls, the strip in Flow analysis turning red near the front, "The wing is stalling / has fully stalled", Cl wobbling (high Cl rms), Cd jumping.</p>
              <p><b>Recover:</b> lower the angle; extending the slat delays the stall. On this grid the air starts breaking away at about:</p>
              <Combos onApply={onApply} rows={[
                ['Clean (slat, flaps stowed)', `${fmt(clean.aoaMax, 1)}°; stalled ${fmt(Math.ceil(clean.aoaMax) + 1)}–${fmt(Math.ceil(clean.aoaMax) + 4)}°+`, `peak ≈ ${fmt(clean.clMax, 2)}`, { label: `clean, ${Math.ceil(clean.aoaMax) + 6}° (stalled)`, slat: 0, flap: 0, aoa: Math.ceil(clean.aoaMax) + 6 }],
                ['Take-off 18° / 20°', `${fmt(takeOff.aoaMax, 1)}°; stalled ${fmt(Math.ceil(takeOff.aoaMax) + 1)}°+`, `peak ≈ ${fmt(takeOff.clMax, 2)}`, { label: `take-off 18° / 20°, ${Math.ceil(takeOff.aoaMax) + 6}° (stalled)`, slat: 18, flap: 20, aoa: Math.ceil(takeOff.aoaMax) + 6 }],
                ['Landing 20° / 30°', `${fmt(landing.aoaMax, 1)}°; stalled ${fmt(Math.ceil(landing.aoaMax) + 1)}°+`, `peak ≈ ${fmt(landing.clMax, 2)}`, { label: `landing 20° / 30°, ${Math.ceil(landing.aoaMax) + 6}° (stalled)`, slat: 20, flap: 30, aoa: Math.ceil(landing.aoaMax) + 6 }],
              ]} /></article>
            <article><h4>Holding lift steady</h4>
              <p>Lift = Cl × q × area, with q = ½ × density × speed². To keep the same lift: <b>raise the angle when you slow down</b> (or extend slats/flaps), <b>lower it when you speed up</b>. Speed needed scales with 1/√Cl: doubling Cl lets you fly about 29% slower.</p>
              <p>Use the calculator below, or Cruise / Autopilot, which do it for you.</p></article>
            <article><h4>Cruise setting</h4>
              <p>Slat and flaps <b>stowed</b>, about 3–6° (Cl ≈ {fmt(clAt('clean', 3), 2)}–{fmt(clAt('clean', 6), 2)}), fast (700–900 km/h). Least drag.</p></article>
            <article><h4>Take-off setting</h4>
              <p>Slat <b>18°</b>, flaps <b>20°</b>, about 4–{fmt(Math.floor(takeOff.aoaMax))}° (Cl up to ≈ {fmt(takeOff.clMax, 2)}). More lift at low speed with moderate drag for climbing away.</p></article>
            <article><h4>Landing setting</h4>
              <p>Slat <b>20–25°</b>, flaps <b>30–35°</b>, about 2–{fmt(Math.floor(landing.aoaMax))}° (Cl up to ≈ {fmt(landing.clMax, 2)}). Most lift and most drag: slow, steep approach.</p></article>
            <article><h4>Pushing down (downforce)</h4>
              <p>Negative angle on a wing (Cl below 0) or the rear wing on the race cars: the low pressure is underneath, so the force points down.</p></article>
          </div>
        </Section>

        <Section id="hold-lift" title="Hold lift steady: calculator">
          <p className="cheat-note">Pick a wing setting and an angle: see the lift coefficient and the speed a {massT} t airliner (360 m² of wing) needs to fly level at that altitude.</p>
          <div className="cheat-calc">
            <label className="select-control"><span>Wing setting</span><span className="select-wrap"><select value={config} onChange={e => setConfig(e.target.value as ConfigName)}>
              <option value="clean">Clean (cruise)</option><option value="take-off flaps">Take-off · slat 18° · flaps 20°</option><option value="landing flaps">Landing · slat 20° · flaps 30°</option>
            </select></span></label>
            <label className="range-control"><span className="control-row"><span>Angle of attack</span><span className="value-chip">{aoa.toFixed(1)} <small>°</small></span></span><input type="range" min={-2} max={14} step={0.5} value={aoa} onChange={e => setAoa(Number(e.target.value))} style={rng(aoa, -2, 14)} /></label>
            <label className="range-control"><span className="control-row"><span>Altitude</span><span className="value-chip">{fmt(altitude)} <small>m</small></span></span><input type="range" min={0} max={13000} step={100} value={altitude} onChange={e => setAltitude(Number(e.target.value))} style={rng(altitude, 0, 13000)} /></label>
            <label className="range-control"><span className="control-row"><span>Aircraft mass</span><span className="value-chip">{massT} <small>t</small></span></span><input type="range" min={60} max={380} step={5} value={massT} onChange={e => setMassT(Number(e.target.value))} style={rng(massT, 60, 380)} /></label>
            <div className="cheat-out">
              <div><span>Section Cl</span><b>{fmt(sectionCl, 2)}</b></div>
              <div><span>Wing CL (3D)</span><b>{fmt(wingCl, 2)}</b></div>
              <div><span>Air density</span><b>{fmt(air.densityKgM3, 3)} kg/m³</b></div>
              <div><span>Speed for level flight</span><b className={pastStall ? 'tone-text-warn' : ''}>{levelSpeed ? `${fmt(levelSpeed * 3.6)} km/h` : 'no lift'}</b></div>
            </div>
            <p className={`cheat-note ${pastStall ? 'tone-text-warn' : ''}`}>{pastStall
              ? `Past about ${fmt(cfgLine.aoaMax, 1)}° the air starts breaking away from this setting on this grid and a stall follows within a few degrees, so the real lift stops rising; the speed above assumes it keeps rising.`
              : `Same lift at another angle: speed₂ = speed₁ × √(Cl₁ / Cl₂). Lower the mass or the altitude, or add flaps, to fly slower.`}</p>
          </div>
        </Section>

        <Section id="air" title="Temperature & pressure">
          <p>Air <b>density</b> follows the ideal-gas law: ρ = p ÷ (287 × T), with T in kelvin (°C + 273.15). <b>Colder</b> or <b>higher-pressure</b> air is denser, so the same speed gives <b>more lift and drag</b>. Hot days and high airfields need longer take-off runs.</p>
          <p><b>Temperature</b> also sets the <b>viscosity</b> (warmer air is slightly stickier, lowering Re) and the <b>speed of sound</b> (colder air has a lower one, so the same speed is a higher Mach number).</p>
          <div className="cheat-isa">
            <div className="cheat-isa-head"><span>Altitude</span><span>Temperature</span><span>Pressure</span><span>Density</span><span>Lift at same speed</span></div>
            {[0, 1500, 3000, 6000, 9000, 11000].map(h => { const a = isa(h); return <div key={h}><span>{fmt(h)} m</span><span>{fmt(a.temperatureC, 1)} °C</span><span>{fmt(a.pressurePa / 1000, 1)} kPa</span><span>{fmt(a.densityKgM3, 3)} kg/m³</span><span>{Math.round(a.densityKgM3 / isa(0).densityKgM3 * 100)}%</span></div> })}
          </div>
          <p className="cheat-note">Standard atmosphere (ISA). With the flight simulation on, temperature and pressure come from the aircraft's altitude automatically.</p>
        </Section>

        <Section id="terms" title="Terms">
          <div className="cheat-table">{TERMS.map(([t, d]) => <div key={t} className="cheat-row"><b className="cheat-sym cheat-term">{t}</b><span>{d}</span></div>)}</div>
        </Section>

        <Section id="controls" title="Controls">
          <div className="cheat-table">{CONTROLS.map(([t, d]) => <div key={t} className="cheat-row"><b className="cheat-sym cheat-term">{t}</b><span>{d}</span></div>)}</div>
        </Section>
      </div>
    </div>
  </div>
}
