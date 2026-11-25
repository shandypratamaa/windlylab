import { useEffect, useRef, type RefObject } from 'react'
import { cfdBodyFor, type ElementRole, type Vec2 } from '../../physics/lbm/geometry.ts'
import { flowVelocity, solvePanelFlow, type PanelFlow } from './panel-flow.ts'

const FILL: Record<ElementRole, string> = { main: '#d4dcde', slat: '#4a78e8', flap: '#e0574a' }
const BACKGROUND = '#080d0f'

/** One wing configuration: slat and flap deflection and angle of attack (degrees). */
interface Setting { slat: number; flap: number; aoa: number }
interface Phase { name: string; from: Setting; to: Setting; seconds: number }

const CRUISE: Setting = { slat: 0, flap: 0, aoa: 3 }
const TAKE_OFF: Setting = { slat: 18, flap: 20, aoa: 7 }
const LANDING: Setting = { slat: 25, flap: 35, aoa: 6 }
/** The loop: hold a configuration, then move the slat, flaps and angle to the next one. */
const CYCLE: Phase[] = [
  { name: 'CRUISE', from: CRUISE, to: CRUISE, seconds: 3.5 },
  { name: 'DEPLOYING FOR TAKE-OFF', from: CRUISE, to: TAKE_OFF, seconds: 2.4 },
  { name: 'TAKE-OFF', from: TAKE_OFF, to: TAKE_OFF, seconds: 3.5 },
  { name: 'EXTENDING FOR LANDING', from: TAKE_OFF, to: LANDING, seconds: 2.4 },
  { name: 'LANDING', from: LANDING, to: LANDING, seconds: 3.5 },
  { name: 'RETRACTING FOR CRUISE', from: LANDING, to: CRUISE, seconds: 2.8 },
]
const CYCLE_SECONDS = CYCLE.reduce((t, p) => t + p.seconds, 0)

/** Slat/flap angle below which the slots are still sealed (they open over the first 6°). */
const SEALED = 6
/** Seconds a line takes to cross the screen in the free stream. */
const CROSSING_SECONDS = 3.2
const PIXELS_PER_TRACER = 1500
const MAX_TRACERS = 1700
/** Share of lines released in the band around the leading edge, which feeds the slots. */
const LE_SHARE = 0.12

const smooth = (t: number) => t * t * (3 - 2 * t)
const mix = (a: Setting, b: Setting, t: number): Setting => ({ slat: a.slat + (b.slat - a.slat) * t, flap: a.flap + (b.flap - a.flap) * t, aoa: a.aoa + (b.aoa - a.aoa) * t })

function settingAt(seconds: number): { setting: Setting; name: string } {
  let t = seconds % CYCLE_SECONDS
  for (const p of CYCLE) {
    if (t <= p.seconds) return { setting: mix(p.from, p.to, smooth(t / p.seconds)), name: p.name }
    t -= p.seconds
  }
  return { setting: CRUISE, name: 'CRUISE' }
}

/**
 * Wing outlines (chord 1, quarter chord at the origin) pitched to the angle of attack.
 * The slat and flaps are always separate elements, so even stowed for cruise they are
 * drawn in their own colours, tucked into the wing's nose and under its tail.
 * `clean` gives the plain one-piece aerofoil instead (used for the flow while the slots are sealed).
 */
function wing(s: Setting, clean = false): { polygons: Vec2[][]; roles: ElementRole[] } {
  const body = cfdBodyFor('aircraft-wing', { airfoil: '2412', slatDeg: clean ? null : s.slat, flapDeg: clean ? null : s.flap, flapType: 'double' })
  const a = -s.aoa * Math.PI / 180
  const c = Math.cos(a); const sn = Math.sin(a)
  return { polygons: body.polygons.map(p => p.map(([x, y]) => [x * c - y * sn, x * sn + y * c] as Vec2)), roles: body.roles ?? body.polygons.map(() => 'main' as ElementRole) }
}

/** Panels per element: ~65 per chord of outline keeps streamlines out of the thin slat and the flap cove. */
const panelsFor = (_: number, perimeter: number) => Math.max(22, Math.round(perimeter * 65))

/**
 * Flow for a setting. While the slots are still sealed (first 6° of travel) the wing is
 * one closed shape, so the flow blends from the clean-wing solution into the slotted one.
 */
function flowFor(s: Setting): { flows: PanelFlow[]; weights: number[] } {
  const open = Math.max(s.slat, s.flap)
  const clean = solvePanelFlow(wing(s, true).polygons, panelsFor)
  if (open <= 0.05) return { flows: [clean], weights: [1] }
  const slotted = solvePanelFlow(wing({ slat: Math.max(s.slat, SEALED), flap: Math.max(s.flap, SEALED), aoa: s.aoa }).polygons, panelsFor)
  const t = Math.min(1, open / SEALED)
  return t >= 1 ? { flows: [slotted], weights: [1] } : { flows: [clean, slotted], weights: [1 - t, t] }
}

/** Steps per frame for lines close to the wing. */
const NEAR_SUBSTEPS = 5

/** Bounding box of the outlines, padded by 0.12 chord. */
function bounds(polygons: Vec2[][]) {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
  for (const poly of polygons) for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  return { x0: x0 - 0.12, x1: x1 + 0.12, y0: y0 - 0.12, y1: y1 + 0.12 }
}

function inside(px: number, py: number, poly: Vec2[]): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!; const [xj, yj] = poly[j]!
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/**
 * Hero background: an airliner wing cycling through cruise, take-off and landing while
 * its slat and double-slotted flaps move, with streamlines from a potential-flow
 * (vortex panel) solution of the whole multi-element wing, recomputed as it moves.
 * Every line enters from the left edge of the screen.
 */
export default function WelcomeFlow({ art }: { art: RefObject<HTMLElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    // Streamline trails live on their own layer that fades a little each frame; the visible
    // canvas is that layer plus the wing drawn crisply on top, so the moving slat and flaps
    // never leave ghost smears.
    const trailCanvas = document.createElement('canvas')
    const trail = trailCanvas.getContext('2d')!
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let w = 0; let h = 0
    const tx = new Float32Array(MAX_TRACERS); const ty = new Float32Array(MAX_TRACERS)
    /** Seconds since release (negative while still waiting at the left edge). */
    const age = new Float32Array(MAX_TRACERS)
    let tracers = 0
    let seeded = false

    // Fixed framing (from all three configurations) so the wing never jumps in size.
    const frame = (() => {
      let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
      for (const s of [CRUISE, TAKE_OFF, LANDING]) for (const p of wing(s).polygons) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
      return { x0, x1, y0, y1 }
    })()

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = rect.width; h = rect.height
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      trailCanvas.width = canvas.width; trailCanvas.height = canvas.height
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      trail.setTransform(dpr, 0, 0, dpr, 0, 0)
      trail.fillStyle = BACKGROUND; trail.fillRect(0, 0, w, h)
      tracers = Math.max(300, Math.min(MAX_TRACERS, Math.round(w * h / PIXELS_PER_TRACER)))
      seeded = false
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    /** Chord-space → screen transform fitting the wing into the art box. */
    const view = () => {
      const box = art.current?.getBoundingClientRect()
      const origin = canvas.getBoundingClientRect()
      const bx = box ? box.left - origin.left : w * 0.5; const by = box ? box.top - origin.top : h * 0.3
      const bw = box ? box.width : w * 0.45; const bh = box ? box.height : h * 0.4
      const scale = Math.min(bw * 0.94 / (frame.x1 - frame.x0), bh * 0.78 / (frame.y1 - frame.y0))
      const cx = bx + bw / 2; const cy = by + bh / 2
      const mx = (frame.x0 + frame.x1) / 2; const my = (frame.y0 + frame.y1) / 2
      return { scale, toX: (x: number) => cx + (x - mx) * scale, toY: (y: number) => cy - (y - my) * scale, fromX: (sx: number) => mx + (sx - cx) / scale, fromY: (sy: number) => my - (sy - cy) / scale }
    }

    let current = wing(CRUISE)
    /** Outlines a line must not enter: the drawn elements, plus the clean outline while the slots are sealed (it covers the seams). */
    let sealedOutline: Vec2[][] | null = wing(CRUISE, true).polygons
    let solids = [...current.polygons, ...sealedOutline]
    let box = bounds(solids)
    let flow = flowFor(CRUISE)
    let solved: Setting = CRUISE
    let frames = 0
    const velocity = (x: number, y: number, out: Float64Array) => {
      if (flow.flows.length === 1) { flowVelocity(flow.flows[0]!, x, y, out); return }
      let u = 0; let v = 0
      flow.flows.forEach((f, i) => { flowVelocity(f, x, y, out); u += flow.weights[i]! * out[0]!; v += flow.weights[i]! * out[1]! })
      out[0] = u; out[1] = v
    }

    /** Release tracer k at the left edge of the screen after `delay` seconds. */
    const release = (k: number, v: ReturnType<typeof view>, delay: number) => {
      const top = v.fromY(-10); const bottom = v.fromY(h + 10)
      // The leading edge's stagnation streamline splits the air over the top, through the
      // slat slot and under the wing into the flap slots, so release more lines around it.
      let leX = Infinity; let leY = 0
      for (const poly of current.polygons) for (const [x, y] of poly) if (x < leX) { leX = x; leY = y }
      ty[k] = Math.random() < LE_SHARE ? leY - 0.2 + Math.random() * 0.32 : bottom + Math.random() * (top - bottom)
      tx[k] = v.fromX(-8) - Math.random() * 0.02
      age[k] = -delay
    }

    const p = new Float64Array(2); const q = new Float64Array(2)
    const start = performance.now()
    let last = start
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now
      const v = view()
      const { setting, name } = reduced ? { setting: LANDING, name: 'LANDING' } : settingAt((now - start) / 1000)
      const moving = Math.abs(setting.slat - solved.slat) + Math.abs(setting.flap - solved.flap) + Math.abs(setting.aoa - solved.aoa) > 0.02
      // Re-solve the panel flow as the wing moves (every other frame is plenty for the eye).
      if (moving && frames++ % 2 === 0) {
        current = wing(setting); flow = flowFor(setting); solved = setting
        sealedOutline = Math.max(setting.slat, setting.flap) < SEALED ? wing(setting, true).polygons : null
        solids = sealedOutline ? [...current.polygons, ...sealedOutline] : current.polygons
        box = bounds(solids)
      }
      const crossing = (v.fromX(w) - v.fromX(0)) / CROSSING_SECONDS
      // The first wave: every line starts at the left edge, released evenly over one crossing.
      if (!seeded) { for (let k = 0; k < tracers; k++) release(k, v, Math.random() * CROSSING_SECONDS); seeded = true }
      // Fade the previous frame: the lines leave soft, smooth trails.
      trail.fillStyle = reduced ? 'rgba(8, 13, 15, 0.5)' : 'rgba(8, 13, 15, 0.07)'
      trail.fillRect(0, 0, w, h)
      const step = crossing * dt * (reduced ? 0.25 : 1)
      const right = v.fromX(w + 10); const top = v.fromY(-20); const bottom = v.fromY(h + 20)
      trail.beginPath()
      for (let k = 0; k < tracers; k++) {
        if (age[k]! < 0) { age[k] = Math.min(0, age[k]! + dt); if (age[k]! < 0) continue }
        let x = tx[k]!; let y = ty[k]!
        // Near the wing, take several small steps and check each one, so a line can follow
        // the curved surface and the narrow slots without cutting across a thin slat or flap.
        const near = x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1
        const n = near ? NEAR_SUBSTEPS : 1
        const h = step / n
        const visible = age[k]! > 0
        if (visible) trail.moveTo(v.toX(x), v.toY(y))
        let gone = false
        for (let i = 0; i < n; i++) {
          // Midpoint (RK2) step keeps the paths smooth.
          velocity(x, y, p)
          velocity(x + 0.5 * h * p[0]!, y + 0.5 * h * p[1]!, q)
          const nx = x + h * q[0]!; const ny = y + h * q[1]!
          if (nx > right || ny > top || ny < bottom || (near && solids.some(poly => inside(nx, ny, poly)))) { gone = true; break }
          x = nx; y = ny
          if (visible) trail.lineTo(v.toX(x), v.toY(y))
        }
        if (gone) { release(k, v, 0); continue }
        tx[k] = x; ty[k] = y; age[k] = age[k]! + dt + 1e-6
      }
      trail.strokeStyle = 'rgba(150, 236, 222, 0.7)'
      trail.lineWidth = 1.15
      trail.lineCap = 'round'
      trail.stroke()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(trailCanvas, 0, 0)
      ctx.setTransform(trailCanvas.width / Math.max(1, w), 0, 0, trailCanvas.height / Math.max(1, h), 0, 0)
      // While the slots are sealed, paint the clean outline first so the stowed elements sit in a solid wing (no dark seams or cove).
      if (sealedOutline) drawWing(ctx, sealedOutline, ['main'], v.toX, v.toY)
      drawWing(ctx, current.polygons, current.roles, v.toX, v.toY)
      drawLabel(ctx, name, setting, v.toX(frame.x0), v.toY(frame.y0) + 28)
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); observer.disconnect() }
  }, [art])

  return <canvas ref={canvasRef} className="welcome-canvas" aria-hidden="true" />
}

function drawWing(ctx: CanvasRenderingContext2D, polygons: Vec2[][], roles: ElementRole[], toX: (x: number) => number, toY: (y: number) => number) {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = 12
  polygons.forEach((poly, i) => {
    ctx.beginPath()
    poly.forEach(([x, y], k) => { if (k === 0) ctx.moveTo(toX(x), toY(y)); else ctx.lineTo(toX(x), toY(y)) })
    ctx.closePath()
    ctx.fillStyle = FILL[roles[i] ?? 'main']
    ctx.fill()
  })
  ctx.restore()
}

/** Configuration readout under the wing, e.g. "TAKE-OFF · SLAT 18° · FLAPS 20° · α 7.0°". */
function drawLabel(ctx: CanvasRenderingContext2D, name: string, s: Setting, x: number, y: number) {
  ctx.save()
  ctx.font = `600 ${ctx.canvas.clientWidth < 560 ? 10 : 11}px "IBM Plex Mono", ui-monospace, monospace`
  // Narrow screens get a compact readout that still fits next to the name.
  const compact = ctx.canvas.clientWidth < 560
  const detail = compact
    ? ` · S ${s.slat < 0.5 ? '0' : Math.round(s.slat)}° · F ${s.flap < 0.5 ? '0' : Math.round(s.flap)}° · α ${s.aoa.toFixed(1)}°`
    : `  ·  SLAT ${s.slat < 0.5 ? 'STOWED' : `${Math.round(s.slat)}°`}  ·  FLAPS ${s.flap < 0.5 ? 'STOWED' : `${Math.round(s.flap)}°`}  ·  α ${s.aoa.toFixed(1)}°`
  // Clear a fixed-width strip (wide enough for the longest label) so neither the trails
  // nor the previous, wider label leave marks behind.
  const width = ctx.measureText(`RETRACTING FOR CRUISE${detail}`).width + 40
  ctx.fillStyle = BACKGROUND
  ctx.fillRect(x - 8, y - 15, width + 16, 23)
  ctx.fillStyle = '#7fe0d4'
  ctx.fillText(name, x, y)
  ctx.fillStyle = '#8fa3a0'
  ctx.fillText(detail, x + ctx.measureText(name).width, y)
  ctx.restore()
}
