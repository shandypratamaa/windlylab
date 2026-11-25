import { ArrowLeft, ArrowRight, BookOpen, GraduationCap, Play, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type TutorialStage = 'basics' | 'advanced'
/** Things a step may ask the app to show first (e.g. the airliner wing or the flight panel). */
export type TutorialPrep = 'wing' | 'flight-panel'

interface Step {
  title: string
  body: ReactNode
  /** Element to spotlight; none = a centred card. */
  target?: () => Element | null
  /** Skip this step when its target isn't on the page (e.g. the OpenFOAM panel on the hosted site). */
  optional?: boolean
  prepare?: TutorialPrep[]
}

/** Find the panel with this heading. */
const panel = (title: string) => () => document.querySelector(`.panel[data-panel="${title}"]`)
/** Find the control (slider, select, field) whose label starts with this text. */
const control = (label: string) => () => [...document.querySelectorAll('label, .range-control, .select-control')].find(el => el.textContent?.trim().startsWith(label)) ?? null
const el = (selector: string) => () => document.querySelector(selector)

const B = ({ children }: { children: ReactNode }) => <b>{children}</b>

/** Part 1: the essentials, for someone who has never used a wind tunnel. */
const BASICS: Step[] = [
  {
    title: 'Welcome to the wind tunnel',
    body: <>
      <p>WindlyLab blows air past an object and works out, cell by cell, how that air moves. You change the object or the air, and the simulation re-solves the flow live.</p>
      <p>This short tour shows the essentials. No aerodynamics background needed. You can skip it any time and reopen it with the <B>Tutorial</B> button at the top.</p>
    </>,
    prepare: ['wing'],
  },
  {
    title: 'The tunnel',
    target: el('.cfd-view'),
    body: <>
      <p>This is a slice through the airliner wing. Air enters from the <B>left</B> and leaves on the right, just like in a real wind tunnel.</p>
      <p>The smoke trails show where the air goes. Where they bunch together, the air is fast; where they spread out or swirl, it is slow or turning back.</p>
    </>,
  },
  {
    title: 'Pick what to test',
    target: el('.left-sidebar .model-list'),
    body: <>
      <p>Choose a <B>shape</B>, a <B>car</B> or the <B>airliner wing</B>. The tabs above switch between the groups.</p>
      <p>The wing is the best place to start: it is built to make lift, and it has movable slats and flaps.</p>
    </>,
  },
  {
    title: 'Angle of attack: tilting the wing',
    target: control('Angle of attack'),
    body: <>
      <p>The <B>angle of attack</B> (written <B>α</B>, "alpha") is how far the wing is tilted nose-up into the oncoming air.</p>
      <p>More angle pushes more air downward, and the air pushes the wing <B>up</B>: that is <B>lift</B>. But past a certain angle the air can no longer follow the top surface, breaks away, and lift collapses. That is a <B>stall</B>.</p>
      <p>Try small steps (1–2°) and watch the smoke and the numbers react.</p>
    </>,
  },
  {
    title: 'Airspeed',
    target: control('Airspeed'),
    body: <>
      <p>How fast the air blows, in km/h. Forces grow with the <B>square</B> of speed: twice as fast means four times the lift and drag.</p>
      <p>An airliner climbs at about 500–700 km/h and lands at about 250 km/h.</p>
    </>,
  },
  {
    title: 'Slats and flaps',
    target: el('.high-lift'),
    body: <>
      <p>The <B>slat</B> (blue) slides out of the wing's nose; the <B>flaps</B> (red) slide out of its tail and droop. Together they make the wing bigger and more curved, so it makes much more lift at <B>low speed</B>: that is how airliners take off and land slowly.</p>
      <p>The gaps (slots) between the parts let fast air from underneath flow over the top, which keeps the air attached longer.</p>
      <p><B>0° = stowed</B> for fast cruising. The flight-mode buttons above can set them for you; more on that in part 2.</p>
    </>,
  },
  {
    title: 'Let it fly itself: flight modes and autopilot',
    target: el('.flight-plan'),
    body: <>
      <p>Instead of moving the sliders yourself, the wing can fly itself. It turns the wing's lift into a whole airliner (200 t by default) and sets the <B>angle, slat and flaps</B> for you.</p>
      <p><B>Climb</B> / <B>Descend</B>: pick the start altitude, how far to go and the <B>rate</B> (how fast, in m/s and ft/min). It shows how long it takes, climbs or descends, then <B>levels off</B> exactly.</p>
      <p><B>Autopilot (altitude hold)</B>: switch it on and type the altitude to hold. It flies there and stays.</p>
      <p>Once level, nothing needs to be gained or lost, so it <B>retracts the slat and flaps</B> whenever the clean wing can carry the aircraft at your speed (less drag). If the airspeed is too low, a <B>stall warning</B> appears: add speed, extend flaps or lower the mass.</p>
    </>,
  },
  {
    title: 'How the air is shown',
    target: panel('SOLVER'),
    body: <>
      <p><B>Smoke</B>: realistic smoke or streaks of particles that follow the air.</p>
      <p><B>Field</B>: colours behind the smoke. <B>Velocity</B> shows air speed; <B>pressure (Cp)</B> shows blue where the pressure is low (it pulls) and red where it is high (it pushes); <B>vorticity</B> shows where the air spins.</p>
      <p>These only change what you see, not the physics.</p>
    </>,
  },
  {
    title: 'The results',
    target: el('.result-grid'),
    body: <>
      <p><B>Cl</B> (lift coefficient, a lowercase L, not a one) is how good the wing is at making lift, independent of speed and size. 0 = no lift; 0.5 is typical for cruise; above 1 needs flaps.</p>
      <p><B>Cd</B> (drag coefficient) is how much the shape resists the air. Smaller is sleeker.</p>
      <p><B>Lift / span</B> and <B>drag / span</B> are the actual forces in newtons for every metre of wing.</p>
    </>,
  },
  {
    title: 'The force graph',
    target: el('.spark-wrap'),
    body: <>
      <p>Drag (Cd) and lift (Cl) over time. Right after a change they jump around while the air adjusts; then they <B>level off</B>.</p>
      <p>A steady line means smooth flow. A line that keeps <B>wobbling</B> means swirls are breaking off the shape: the wing is shaking, as it does near a stall.</p>
    </>,
  },
  {
    title: 'Wait for the numbers to settle',
    target: el('.overlay-tag'),
    body: <>
      <p>After every change the air needs a moment to adjust. This tag shows <B>SETTLING</B> or <B>ADAPTING</B> with a percentage, then <B>STATISTICS SETTLED</B>.</p>
      <p>Read the results once it says settled. They are averaged over time, so they are steady.</p>
    </>,
  },
  {
    title: 'Flow analysis: what is happening, in words',
    target: panel('FLOW ANALYSIS'),
    body: <>
      <p>This panel explains the flow in everyday language: "smooth flow", "air is peeling off", "the wing is stalling", "swirls are breaking off"…</p>
      <p>When something important changes, a short message also pops up over the tunnel. The strip shows where along the wing the air stays attached (green) and where it has broken away (red).</p>
    </>,
  },
  {
    title: 'Pause, restart, reset',
    target: el('.topbar'),
    body: <>
      <p><B>Pause</B> (or the space bar) freezes the air so you can look closely. <B>Restart flow</B> (or R) starts the air from rest. <B>Reset all</B> puts every setting back to the start.</p>
      <p>The <B>Tutorial</B> button up here reopens this tour.</p>
      <div className="tour-callout"><BookOpen size={15} /><p><B>Before you start, open the Cheat sheet</B> (next to Tutorial). It explains every symbol (Cl, Cd, α, Re…) and shows the slat, flap and angle settings for generating lift, climbing, losing lift and stalling, each with a one-click <B>Apply</B> button. It is the quickest way to understand what you see.</p></div>
    </>,
  },
]

/** Part 2: every remaining control and term. */
const ADVANCED: Step[] = [
  {
    title: 'Part 2: every control',
    body: <>
      <p>This part goes through each remaining button and setting, and what the symbols mean. It takes about five minutes.</p>
      <p>The <B>Cheat sheet</B> keeps all of it on one page afterwards, with scenarios such as stalling, losing lift and holding lift steady.</p>
    </>,
    prepare: ['wing'],
  },
  {
    title: 'Top bar',
    target: el('.topbar'),
    body: <>
      <p><B>Welcome</B> returns to the start page. The status shows the grid size in cells and how many solver <B>steps per second</B> your computer manages: more steps per second means the air settles faster.</p>
      <p><B>Pause</B> (space), <B>Restart flow</B> (R), <B>Reset all</B>, then <B>Tutorial</B> and <B>Cheat sheet</B>.</p>
    </>,
  },
  {
    title: 'Model tabs and notes',
    target: el('.left-sidebar .category-tabs'),
    body: <>
      <p><B>Shapes</B>: cube, cylinder, sphere, wedge and flat plate, useful for seeing swirls (vortex shedding). <B>Cars</B>: six cars, some with spoilers or rear wings that push the car down (downforce). <B>Aircraft</B>: the airliner wing.</p>
      <p>Everything is solved as a 2D slice, noted under the list.</p>
    </>,
  },
  {
    title: 'Airfoil',
    target: control('Airfoil'),
    body: <>
      <p>The wing's cross-section shape. <B>NACA 0012</B> is symmetric (the same on top and bottom), so at 0° it makes no lift. <B>NACA 2412</B> is cambered (curved), so it makes lift even at 0°: airliner wings are cambered.</p>
    </>,
  },
  {
    title: 'Model scale and blockage',
    target: control('Model scale'),
    body: <>
      <p>Resizes the model inside the tunnel. Bigger models are drawn with more cells (finer detail) but block more of the tunnel.</p>
      <p><B>Blockage</B> is the share of the tunnel height the model fills. Above about 10% the walls squeeze the air and exaggerate the forces; at 1× it stays under 5%.</p>
    </>,
  },
  {
    title: 'Flight modes',
    target: el('.flight-plan'),
    body: <>
      <p><B>Cruise</B> levels off and holds the current altitude. <B>Climb</B> and <B>Descend</B> ask for a <B>start altitude</B>, how far to go and a <B>rate</B> (m/s and ft/min), show the time to get there, and set the angle, slats and flaps automatically.</p>
      <p><B>Autopilot (altitude hold)</B> is its own mode: it asks for an altitude and flies there. Moving the angle, slat or flap sliders by hand switches any automatic mode off.</p>
    </>,
  },
  {
    title: 'Slat, flap and flap type',
    target: control('Flap type'),
    body: <>
      <p>The <B>slat</B> slider (0–30°) and <B>flaps</B> slider (0–40°) move the parts directly. <B>Double-slotted</B> flaps have two pieces with two gaps (most airliners); <B>single-slotted</B> have one.</p>
      <p>On the Low and Medium grids the slots are only a couple of cells wide; <B>Use High grid</B> resolves the air in them better.</p>
    </>,
  },
  {
    title: 'Zoom, focus and full screen',
    target: el('.cfd-zoom'),
    body: <>
      <p>Zoom in and out, <B>focus</B> on the model, or show the <B>whole tunnel</B>. Drag to pan, scroll to zoom. The full-screen button is in the tunnel's top-right corner.</p>
      <p><B>Click</B> anywhere in the air to add your own smoke wand; <B>hover</B> to read the speed and pressure at that point.</p>
    </>,
  },
  {
    title: 'Smoke wands and injectors',
    target: control('Smoke wands'),
    body: <>
      <p>How many smoke lines are released at the left. <B>Clear injectors</B> (below) removes the wands you added by clicking.</p>
    </>,
  },
  {
    title: 'Grid',
    target: control('Grid'),
    body: <>
      <p>How finely the air is divided into cells. <B>Low</B> is fastest, <B>High</B> most detailed (100 cells across the wing). Finer grids show thinner layers of air and resolve the slots, but each change takes longer to settle.</p>
    </>,
  },
  {
    title: 'Reynolds number (Re)',
    target: control('Reynolds number'),
    body: <>
      <p><B>Re</B> compares how strongly the air keeps moving (its momentum) with how sticky it is (viscosity). Big, fast things have a large Re (a real airliner: around 30 million); small, slow things have a small Re (an insect: a few thousand).</p>
      <p><B>Match real air</B> uses your speed, size, temperature and pressure, up to the most the grid can resolve (about 6,000–11,000). That is why the simulated wing behaves like a small model: it makes less lift and stalls earlier than a full-size wing.</p>
    </>,
  },
  {
    title: 'Temperature, pressure, reference length',
    target: panel('AIR & SCALE'),
    body: <>
      <p><B>Temperature</B> and <B>static pressure</B> set the air's <B>density</B> (ρ, "rho"): colder or higher-pressure air is denser and gives more lift at the same speed. Temperature also changes the <B>viscosity</B> (μ, "mu") and the speed of sound.</p>
      <p><B>Reference length</B> is the real size of the model (the wing's <B>chord</B>, front to back). It turns the coefficients into real forces and sets the physical Re.</p>
      <p>Below: density, viscosity, <B>dynamic pressure</B> (q, the "push" of the moving air, ½ρV²), physical Re and <B>Mach</B> (speed ÷ speed of sound).</p>
    </>,
  },
  {
    title: 'More results',
    target: el('.panel[data-panel="RESULTS"] .metric-list'),
    body: <>
      <p><B>Lift-to-drag ratio</B> (L/D): lift for every unit of drag; higher means a more efficient wing (gliders: 40+). <B>Strouhal number</B> (St): how often swirls break off, scaled by size and speed (about 0.2 behind a cylinder). <B>Lift fluctuation (rms)</B>: how much the lift wobbles. <B>Tunnel blockage</B> and <B>reference length</B> as before.</p>
    </>,
  },
  {
    title: 'Help buttons',
    target: el('.panel .help-button'),
    body: <>
      <p>Every panel with a <B>?</B> button has a short explanation inside. Hovering over a slider also shows what it does.</p>
    </>,
  },
  {
    title: 'Flight simulation panel',
    target: el('.flight-panel'),
    prepare: ['flight-panel'],
    body: <>
      <p>Turns the wing's lift into a whole airliner (360 m² of wing) at altitude.</p>
      <p><B>Altitude & air</B>: the standard atmosphere (ISA) sets temperature, pressure and density from your altitude. <B>Speed</B>: true airspeed (TAS), equivalent airspeed (EAS, what the pilot's gauge feels) and Mach. <B>Lift vs weight</B>: if lift is less than weight the aircraft sinks. <B>Flight path</B>: altitude over time, with <B>Time speed</B> to run the flight faster (1–60×).</p>
    </>,
  },
  {
    title: 'OpenFOAM cross-check',
    target: panel('OPENFOAM CROSS-CHECK'),
    optional: true,
    body: <>
      <p>An optional check with OpenFOAM, a professional CFD program, on a full-size NACA 0012 wing. It only works when it is installed and running on your computer; otherwise the button stays disabled.</p>
    </>,
  },
  {
    title: "That's everything",
    body: <>
      <p>Open the <B>Cheat sheet</B> for every symbol, the scenarios (generating lift, stalled, losing lift, holding lift steady, take-off and landing settings), a calculator and what temperature and pressure do.</p>
    </>,
  },
]

interface Props {
  stage: TutorialStage
  onSkip: () => void
  /** End of part 1: try it yourself (finish) or continue with part 2. */
  onBasicsDone: (next: 'try' | 'continue' | 'cheat-sheet') => void
  onAdvancedDone: (openCheatSheet: boolean) => void
  prepare: (what: TutorialPrep) => void
}

/**
 * Guided tour: dims the page, spotlights one control at a time and explains it. The
 * page underneath can't be clicked until the tour ends or is skipped.
 */
export default function Tutorial({ stage, onSkip, onBasicsDone, onAdvancedDone, prepare }: Props) {
  const steps = useMemo(() => (stage === 'basics' ? BASICS : ADVANCED).filter(s => !s.optional || s.target?.()), [stage])
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const [cardSize, setCardSize] = useState({ w: 380, h: 260 })
  const step = steps[index]!
  const last = index === steps.length - 1

  useEffect(() => { setIndex(0) }, [stage])
  // Show what the step needs, bring its target into view, then track its position.
  useEffect(() => {
    step.prepare?.forEach(prepare)
    let raf = 0
    const scrolled = { done: false }
    const track = () => {
      const target = step.target?.() ?? null
      if (target && !scrolled.done) { target.scrollIntoView({ block: 'center', inline: 'nearest' }); scrolled.done = true }
      const r = target?.getBoundingClientRect() ?? null
      setRect(prev => (r && prev && Math.abs(prev.x - r.x) < 0.5 && Math.abs(prev.y - r.y) < 0.5 && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5) ? prev : (r && r.width > 0 ? r : null))
      raf = requestAnimationFrame(track)
    }
    // Give "prepare" a frame to render before measuring.
    raf = requestAnimationFrame(() => requestAnimationFrame(track))
    return () => cancelAnimationFrame(raf)
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const r = card.current?.getBoundingClientRect()
    if (r && (Math.abs(r.width - cardSize.w) > 1 || Math.abs(r.height - cardSize.h) > 1)) setCardSize({ w: r.width, h: r.height })
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSkip()
      else if (e.key === 'ArrowRight' && !last) setIndex(i => i + 1)
      else if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [last, onSkip])

  // Place the card beside the spotlight where there's room (right, left, below, above), else centred.
  const vw = window.innerWidth; const vh = window.innerHeight; const pad = 14
  let pos: { left: number; top: number }
  if (!rect) pos = { left: (vw - cardSize.w) / 2, top: (vh - cardSize.h) / 2 }
  else if (vw < 700) pos = { left: (vw - cardSize.w) / 2, top: rect.bottom + pad + cardSize.h < vh ? rect.bottom + pad : Math.max(pad, rect.top - pad - cardSize.h) }
  else if (rect.right + pad + cardSize.w < vw) pos = { left: rect.right + pad, top: rect.top + rect.height / 2 - cardSize.h / 2 }
  else if (rect.left - pad - cardSize.w > 0) pos = { left: rect.left - pad - cardSize.w, top: rect.top + rect.height / 2 - cardSize.h / 2 }
  else if (rect.bottom + pad + cardSize.h < vh) pos = { left: rect.left + rect.width / 2 - cardSize.w / 2, top: rect.bottom + pad }
  else pos = { left: rect.left + rect.width / 2 - cardSize.w / 2, top: rect.top - pad - cardSize.h }
  pos = { left: Math.max(pad, Math.min(vw - cardSize.w - pad, pos.left)), top: Math.max(pad, Math.min(vh - cardSize.h - pad, pos.top)) }

  const spot = rect ? { left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 } : null
  return <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
    {spot ? <div className="tour-spot" style={spot} /> : <div className="tour-dim" />}
    <div ref={card} className="tour-card" style={pos}>
      <div className="tour-head">
        <span className="tour-part"><GraduationCap size={13} /> {stage === 'basics' ? 'TUTORIAL · PART 1 OF 2' : 'TUTORIAL · PART 2 OF 2'}</span>
        <button type="button" className="icon-button" aria-label="Skip the tutorial" title="Skip the tutorial (Esc)" onClick={onSkip}><X size={14} /></button>
      </div>
      <h2 id="tour-title">{step.title}</h2>
      <div className="tour-body">{step.body}</div>
      <div className="tour-progress" aria-hidden="true">{steps.map((_, i) => <i key={i} className={i === index ? 'on' : i < index ? 'done' : ''} />)}</div>
      <div className="tour-actions">
        <span className="tour-count">{index + 1} / {steps.length}</span>
        {index > 0 && <button type="button" className="subtle-button" onClick={() => setIndex(i => i - 1)}><ArrowLeft size={13} /> Back</button>}
        {!last && <>
          <button type="button" className="tour-skip" onClick={onSkip}>Skip tutorial</button>
          <button type="button" className="start-button tour-next" onClick={() => setIndex(i => i + 1)}>Next <ArrowRight size={14} /></button>
        </>}
        {last && stage === 'basics' && <>
          <button type="button" className="subtle-button tour-cheat" onClick={() => onBasicsDone('cheat-sheet')}><BookOpen size={13} /> Open cheat sheet</button>
          <button type="button" className="subtle-button" onClick={() => onBasicsDone('continue')}><GraduationCap size={13} /> Continue tutorial</button>
          <button type="button" className="start-button tour-next" onClick={() => onBasicsDone('try')}><Play size={14} /> Try it yourself</button>
        </>}
        {last && stage === 'advanced' && <>
          <button type="button" className="subtle-button" onClick={() => onAdvancedDone(false)}>Finish</button>
          <button type="button" className="start-button tour-next" onClick={() => onAdvancedDone(true)}><BookOpen size={14} /> Open cheat sheet</button>
        </>}
      </div>
    </div>
  </div>
}
