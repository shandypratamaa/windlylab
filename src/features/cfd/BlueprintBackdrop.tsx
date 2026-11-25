import { useMemo } from 'react'
import { cfdBodyFor, type ElementRole, type Vec2 } from '../../physics/lbm/geometry.ts'

/** The three standard airliner high-lift positions, drawn from the simulator's own wing geometry. */
const CONFIGS = [
  { tag: '(A)', name: 'RETRACTED · CRUISE', slat: 0, flap: 0 },
  { tag: '(B)', name: 'TAKE-OFF', slat: 18, flap: 20 },
  { tag: '(C)', name: 'LANDING', slat: 25, flap: 35 },
] as const

const CHORD_PX = 560
const STROKE: Record<ElementRole, string> = { main: '#7fe0d4', slat: '#6f9cff', flap: '#ff7a68' }
const FILL: Record<ElementRole, string> = { main: 'rgba(127, 224, 212, 0.05)', slat: 'rgba(111, 156, 255, 0.16)', flap: 'rgba(255, 122, 104, 0.16)' }

const path = (poly: Vec2[], ox: number, oy: number) =>
  poly.map(([x, y], i) => `${i ? 'L' : 'M'}${(ox + (x + 0.25) * CHORD_PX).toFixed(1)} ${(oy - y * CHORD_PX).toFixed(1)}`).join(' ') + 'Z'

/**
 * Faint engineering-drawing backdrop for the description section: a blueprint grid and
 * the wing in its retracted, take-off and landing positions with callouts, chord and
 * dimension lines. Decorative only.
 */
export default function BlueprintBackdrop() {
  const drawings = useMemo(() => CONFIGS.map(c => {
    const body = cfdBodyFor('aircraft-wing', { airfoil: '2412', slatDeg: c.slat, flapDeg: c.flap, flapType: 'double' })
    const roles = body.roles ?? body.polygons.map(() => 'main' as ElementRole)
    return { ...c, polygons: body.polygons, roles }
  }), [])

  const left = 120
  const rowHeight = 280
  // The grid covers the whole section (CSS); detail drawings sit on the left, the three positions on the right.
  return <div className="blueprint-backdrop" aria-hidden="true">
  <BlueprintDetails slotted={drawings[1]!} landing={drawings[2]!} />
  <svg className="bp-right" viewBox="0 0 900 1180" preserveAspectRatio="xMaxYMin meet" focusable="false">
    <defs>
      <marker id="bp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z" fill="#7fe0d4" /></marker>
    </defs>

    {/* Title block, like the corner of a drawing sheet. */}
    <g className="bp-text" transform="translate(560 1150)">
      <rect x="0" y="-34" width="320" height="46" fill="none" stroke="#7fe0d4" strokeOpacity="0.35" />
      <line x1="0" y1="-12" x2="320" y2="-12" stroke="#7fe0d4" strokeOpacity="0.25" />
      <text x="10" y="-18">WINDLYLAB · HIGH-LIFT SYSTEM</text>
      <text x="10" y="5" className="bp-small">NACA 2412 · SLAT + DOUBLE-SLOTTED FLAP · SHEET 1/1</text>
    </g>

    {drawings.map((d, i) => {
      // Start below the intro paragraph so the drawings sit beside the cards, not behind the text.
      const oy = 330 + i * rowHeight
      const ox = left
      const le = ox; const te = ox + CHORD_PX
      const flapIdx = d.roles.map((r, k) => (r === 'flap' ? k : -1)).filter(k => k >= 0)
      const slatIdx = d.roles.indexOf('slat')
      // Anchor points for the callouts.
      const slatTip = slatIdx >= 0 ? d.polygons[slatIdx]!.reduce((a, p) => (p[0] < a[0] ? p : a)) : null
      const flapMid = flapIdx.length ? d.polygons[flapIdx[0]!]!.reduce((a, p) => (p[1] < a[1] ? p : a)) : null
      const px = (x: number) => ox + (x + 0.25) * CHORD_PX
      const py = (y: number) => oy - y * CHORD_PX
      return <g key={d.name}>
        <text className="bp-text bp-title" x={ox} y={oy - 70}>{d.tag} {d.name}</text>
        <text className="bp-text bp-small" x={ox} y={oy - 54}>SLAT {d.slat ? `${d.slat}°` : 'STOWED'} · FLAPS {d.flap ? `${d.flap}°` : 'STOWED'}{d.slat ? ' · SLOT GAP 3% c' : ''}</text>
        {/* Chord line and centre marks. */}
        <line x1={le - 30} y1={oy} x2={te + 70} y2={oy} stroke="#7fe0d4" strokeOpacity="0.35" strokeDasharray="14 4 2 4" strokeWidth="0.8" />
        <line x1={ox + 0.25 * CHORD_PX} y1={oy - 18} x2={ox + 0.25 * CHORD_PX} y2={oy + 18} stroke="#7fe0d4" strokeOpacity="0.35" strokeWidth="0.8" />
        <text className="bp-text bp-small" x={ox + 0.25 * CHORD_PX + 6} y={oy + 30}>c/4</text>
        {d.polygons.map((poly, k) => <path key={k} d={path(poly, ox, oy)} fill={FILL[d.roles[k] ?? 'main']} stroke={STROKE[d.roles[k] ?? 'main']} strokeOpacity="0.9" strokeWidth="1.4" strokeLinejoin="round" />)}
        {/* Chord dimension. */}
        <g stroke="#7fe0d4" strokeOpacity="0.45" strokeWidth="0.8" fill="none">
          <line x1={le} y1={oy + 50} x2={le} y2={oy + 92} />
          <line x1={te} y1={oy + 50} x2={te} y2={oy + 92} />
          <line x1={le + 2} y1={oy + 84} x2={te - 2} y2={oy + 84} markerStart="url(#bp-arrow)" markerEnd="url(#bp-arrow)" />
        </g>
        <text className="bp-text bp-small" x={(le + te) / 2} y={oy + 78} textAnchor="middle">c = 1.000 (CHORD)</text>
        {/* Callouts. */}
        {slatTip && <g stroke="#6f9cff" strokeOpacity="0.6" strokeWidth="0.8" fill="none">
          <polyline points={`${px(slatTip[0])},${py(slatTip[1])} ${px(slatTip[0]) - 34},${py(slatTip[1]) - 46} ${px(slatTip[0]) - 84},${py(slatTip[1]) - 46}`} />
          <circle cx={px(slatTip[0])} cy={py(slatTip[1])} r="2.5" fill="#6f9cff" />
        </g>}
        {slatTip && <text className="bp-text bp-small bp-slat" x={px(slatTip[0]) - 84} y={py(slatTip[1]) - 52}>SLAT</text>}
        {flapMid && <g stroke="#ff7a68" strokeOpacity="0.6" strokeWidth="0.8" fill="none">
          <polyline points={`${px(flapMid[0])},${py(flapMid[1])} ${px(flapMid[0]) + 40},${py(flapMid[1]) + 50} ${px(flapMid[0]) + 150},${py(flapMid[1]) + 50}`} />
          <circle cx={px(flapMid[0])} cy={py(flapMid[1])} r="2.5" fill="#ff7a68" />
        </g>}
        {flapMid && <text className="bp-text bp-small bp-flap" x={px(flapMid[0]) + 44} y={py(flapMid[1]) + 44}>DOUBLE-SLOTTED FLAP</text>}
        {/* Flap deflection arc for the deployed positions. */}
        {d.flap > 0 && (() => {
          // Arc about the flap hinge (just under the main wing's trailing edge), from the chord line down to the flap angle.
          const hx = px(0.5); const r = 110; const a = d.flap * Math.PI / 180
          return <g stroke="#ff7a68" strokeOpacity="0.45" strokeWidth="0.8" fill="none">
            <line x1={hx} y1={oy} x2={hx + (r + 16) * Math.cos(a)} y2={oy + (r + 16) * Math.sin(a)} strokeDasharray="4 3" />
            <path d={`M${hx + r} ${oy} A${r} ${r} 0 0 1 ${hx + r * Math.cos(a)} ${oy + r * Math.sin(a)}`} markerEnd="url(#bp-arrow)" />
          </g>
        })()}
        {d.flap > 0 && <text className="bp-text bp-small bp-flap" x={te + 8} y={oy + 26}>δf {d.flap}°</text>}
      </g>
    })}
  </svg>
  </div>
}

type Drawing = { tag: string; name: string; slat: number; flap: number; polygons: Vec2[][]; roles: ElementRole[] }

/**
 * Left-hand sheet: magnified details of the slat slot (take-off) and the flap slots
 * (landing), drawn like detail views on an engineering drawing.
 */
function BlueprintDetails({ slotted, landing }: { slotted: Drawing; landing: Drawing }) {
  const detail = (d: Drawing, cx: number, cy: number, scale: number, ox: number, oy: number) => {
    // Chord coordinates around (cx, cy) magnified into a circle at (ox, oy).
    const tx = (x: number) => ox + (x - cx) * scale
    const ty = (y: number) => oy - (y - cy) * scale
    return d.polygons.map((poly, k) => <path key={k} d={poly.map(([x, y], i) => `${i ? 'L' : 'M'}${tx(x).toFixed(1)} ${ty(y).toFixed(1)}`).join(' ') + 'Z'}
      fill={FILL[d.roles[k] ?? 'main']} stroke={STROKE[d.roles[k] ?? 'main']} strokeOpacity="0.9" strokeWidth="1.3" strokeLinejoin="round" />)
  }
  const R = 150
  return <svg className="bp-left" viewBox="0 0 520 1180" preserveAspectRatio="xMinYMin meet" focusable="false">
    <defs>
      <clipPath id="bp-detail-b"><circle cx="230" cy="300" r={R} /></clipPath>
      <clipPath id="bp-detail-c"><circle cx="250" cy="760" r={R} /></clipPath>
      <marker id="bp-arrow-l" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z" fill="#7fe0d4" /></marker>
    </defs>
    {/* Detail B: slat slot, take-off. */}
    <text className="bp-text bp-title" x="80" y="118">DETAIL B · SLAT SLOT</text>
    <text className="bp-text bp-small" x="80" y="134">TAKE-OFF · SLAT {slotted.slat}° · SCALE 4 : 1</text>
    <circle cx="230" cy="300" r={R} fill="none" stroke="#7fe0d4" strokeOpacity="0.35" strokeDasharray="6 4" />
    <g clipPath="url(#bp-detail-b)">{detail(slotted, -0.2, -0.01, 1050, 230, 300)}</g>
    <line x1="230" y1={300 - R - 14} x2="230" y2={300 + R + 14} stroke="#7fe0d4" strokeOpacity="0.2" strokeDasharray="10 3 2 3" />
    <line x1={230 - R - 14} y1="300" x2={230 + R + 14} y2="300" stroke="#7fe0d4" strokeOpacity="0.2" strokeDasharray="10 3 2 3" />
    <g stroke="#6f9cff" strokeOpacity="0.6" fill="none" strokeWidth="0.8"><polyline points="190,330 120,410 60,410" /></g>
    <text className="bp-text bp-small bp-slat" x="60" y="404">SLOT · GAP 0.03 c</text>
    <text className="bp-text bp-small" x="300" y="470">AIR FROM BELOW RE-ENERGISES</text>
    <text className="bp-text bp-small" x="300" y="482">THE MAIN WING'S UPPER SURFACE</text>

    {/* Detail C: flap slots, landing. */}
    <text className="bp-text bp-title" x="80" y="578">DETAIL C · FLAP SLOTS</text>
    <text className="bp-text bp-small" x="80" y="594">LANDING · FORE + AFT FLAP · δf {landing.flap}° · SCALE 3 : 1</text>
    <circle cx="250" cy="760" r={R} fill="none" stroke="#7fe0d4" strokeOpacity="0.35" strokeDasharray="6 4" />
    <g clipPath="url(#bp-detail-c)">{detail(landing, 0.78, -0.09, 620, 250, 760)}</g>
    <line x1="250" y1={760 - R - 14} x2="250" y2={760 + R + 14} stroke="#7fe0d4" strokeOpacity="0.2" strokeDasharray="10 3 2 3" />
    <line x1={250 - R - 14} y1="760" x2={250 + R + 14} y2="760" stroke="#7fe0d4" strokeOpacity="0.2" strokeDasharray="10 3 2 3" />
    <g stroke="#ff7a68" strokeOpacity="0.6" fill="none" strokeWidth="0.8"><polyline points="300,820 380,900 470,900" /></g>
    <text className="bp-text bp-small bp-flap" x="384" y="894">2 SLOTS · 0.03 c</text>
    <text className="bp-text bp-small" x="80" y="950">EACH SLOT FEEDS FAST AIR OVER THE NEXT</text>
    <text className="bp-text bp-small" x="80" y="962">ELEMENT SO THE FLOW STAYS ATTACHED</text>

    {/* Free-stream arrows. */}
    <g stroke="#7fe0d4" strokeOpacity="0.4" strokeWidth="0.9" fill="none">
      {[1040, 1070, 1100].map(y => <line key={y} x1="80" y1={y} x2="220" y2={y} markerEnd="url(#bp-arrow-l)" />)}
    </g>
    <text className="bp-text bp-small" x="236" y="1074">V∞ · FREE STREAM</text>
  </svg>
}
