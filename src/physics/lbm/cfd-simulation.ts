import type { ModelKind } from '../../types/index.ts'
import { LbmSolver, type ThreadLike } from './lbm-solver.ts'
import { cfdBodyFor, layoutBody, rasterize, tunnelFor, type FlapType, type AirfoilCode, type CfdBody, type CfdLayout, type Tunnel, type Vec2 } from './geometry.ts'

export type CfdResolution = 'low' | 'medium' | 'high'
/** Cells per unit chord for wings and plates. */
export const RESOLUTION_BASE: Record<CfdResolution, number> = { low: 56, medium: 72, high: 100 }
/** Cells across the frontal height of bluff bodies and cars at model scale 1×. */
export const FRONTAL_CELLS: Record<CfdResolution, number> = { low: 9, medium: 12, high: 18 }
/** Inlet speed in lattice units (lattice Mach ≈ 0.17). */
export const LATTICE_U = 0.1
/** Smallest lattice viscosity the LES-stabilised solver is allowed to use. */
export const MIN_LATTICE_NU = 0.0009

export interface CfdParams {
  kind: ModelKind
  airfoil: AirfoilCode
  angleOfAttackDeg: number
  resolution: CfdResolution
  reynolds: number
  smokeLines: number
  /** Model scale relative to the default size (1 = about 4.5% tunnel blockage). */
  scale: number
  rearWingDeg: number
  slatDeg: number | null
  flapDeg: number | null
  flapType: FlapType
  /** Approximate 3D side-bypass flow behind vehicles (calibrated model). */
  sideRelief: boolean
  /** Lattice steps between smoke puffs from each wand (default 5; smaller = smoother streaklines). */
  smokeEmitEvery?: number
}

/** The parts of the parameters that move the body (eased over time). */
interface Geom { angleOfAttackDeg: number; scale: number; rearWingDeg: number; slatDeg: number | null; flapDeg: number | null }
const geomOf = (p: CfdParams): Geom => ({ angleOfAttackDeg: p.angleOfAttackDeg, scale: p.scale, rearWingDeg: p.rearWingDeg, slatDeg: p.slatDeg, flapDeg: p.flapDeg })
const sameGeom = (a: Geom, b: Geom) => a.angleOfAttackDeg === b.angleOfAttackDeg && a.scale === b.scale && a.rearWingDeg === b.rearWingDeg && a.slatDeg === b.slatDeg && a.flapDeg === b.flapDeg

export type BodyParams = Pick<CfdParams, 'kind' | 'airfoil' | 'scale' | 'rearWingDeg' | 'slatDeg' | 'flapDeg' | 'flapType' | 'resolution'>

export const tunnelOf = (p: BodyParams): Tunnel => tunnelFor(p.kind, p.airfoil, RESOLUTION_BASE[p.resolution], FRONTAL_CELLS[p.resolution])

/** Body geometry for the given parameters at its absolute scale in the tunnel. */
export function bodyOf(p: BodyParams, tunnel = tunnelOf(p)): CfdBody {
  return cfdBodyFor(p.kind, { airfoil: p.airfoil, scale: tunnel.defaultScale * p.scale, rearWingDeg: p.rearWingDeg, slatDeg: p.slatDeg, flapDeg: p.flapDeg, flapType: p.flapType ?? 'single' })
}

/**
 * Side-relief ("2.5D") strength. Around the car and through its near wake, local
 * pressure relaxes towards ambient at RELIEF_GAIN · U / W per step (W ≈ 0.45 × car
 * length, the car width): a mass bleed standing in for air that flows around the
 * sides of a real 3D car. Measured effect: it consistently cuts the exaggerated 2D
 * roof lift (typically 30–50%). Its effect on drag depends on shape and grid —
 * e.g. medium grid SUV Cd 2.2 → 0.57 and sports car ≈0.33, but the coupe stays
 * ≈1.1 and low-grid runs barely change. It is an approximation, not a 3D flow.
 */
export const RELIEF_GAIN = 1.5

export type SmokeMode = 'none' | 'particles' | 'dye'

/** Time-averaged near-wall flow on one side of a lifting section. */
export interface SurfaceFlow {
  /** x/c where reversed flow first appears (null = attached to the trailing edge). */
  separation: number | null
  /** Fraction of the chord covered by reversed flow. */
  reversedFraction: number
}

export interface CfdStats {
  step: number
  flowThroughs: number
  settled: boolean
  /** Flow-throughs needed since the last change before the averages count as settled. */
  settleFlowThroughs: number
  cd: number
  cl: number
  cdMean: number
  clMean: number
  cdStd: number
  clStd: number
  strouhal: number | null
  reynolds: number
  maxReynolds: number
  blockage: number
  latticeNu: number
  tau: number
  diverged: boolean
  forceLengthLabel: string
  /** Near-wall flow on the suction side (the side lift pulls towards); null for non-lifting bodies. */
  suction: SurfaceFlow | null
  /** Near-wall flow on the pressure side. */
  pressureSide: SurfaceFlow | null
}

const HISTORY_EVERY = 10
const HISTORY_SIZE = 1200
const PARTICLE_CAPACITY = 60000
const SURFACE_BINS = 40
/** EMA weight per force sample (every 10 steps): ~1,000-step memory, longer than a shedding cycle. */
const SURFACE_EMA = 0.01

export function maxReynoldsFor(p: BodyParams): number {
  const tunnel = tunnelOf(p)
  return Math.floor(LATTICE_U * bodyOf(p, tunnel).reynoldsLength * tunnel.base / MIN_LATTICE_NU)
}

/** Lattice Boltzmann tunnel plus smoke streaklines and force statistics. Runs anywhere (worker, Node, main thread). */
/** Flow-throughs of the tunnel before a fresh start counts as settled (start-up vortex gone). */
const FRESH_SETTLE = 1.2
/** Shortest re-settle after a change to developed flow (about 2.5 chords of travel on the default grid). */
const MIN_RESETTLE = 0.45

/**
 * How long developed flow needs to adapt to a change, in tunnel flow-throughs: a small
 * angle tweak re-establishes the circulation within a couple of chords, while moving
 * slats and flaps or resizing the body changes the whole near field.
 */
function resettleFor(prev: CfdParams, next: CfdParams): number {
  const aoa = Math.abs(next.angleOfAttackDeg - prev.angleOfAttackDeg)
  const devices = Math.abs((next.slatDeg ?? 0) - (prev.slatDeg ?? 0)) + Math.abs((next.flapDeg ?? 0) - (prev.flapDeg ?? 0)) + Math.abs(next.rearWingDeg - prev.rearWingDeg)
  const scale = Math.abs(Math.log(next.scale / prev.scale))
  if (aoa === 0 && devices === 0 && scale === 0) return 0
  return Math.min(FRESH_SETTLE, MIN_RESETTLE + 0.06 * aoa + 0.012 * devices + 1.5 * scale)
}

/**
 * Heights (cells) of extra smoke wands for a car on the ground: mid-way under the floor,
 * across the front of the body (nose to roof), and just above and below any spoiler or
 * wing (the polygons after the body and two wheels). It is given the model at a fixed
 * reference spoiler angle, so adjusting the spoiler never moves the wands.
 */
function carWandHeights(polygons: Vec2[][]): number[] {
  const car = polygons[0]
  if (!car) return []
  const ys = car.map(p => p[1])
  const floor = Math.min(...ys); const roof = Math.max(...ys)
  const out: number[] = []
  if (floor > 1.6) out.push(floor / 2)
  for (const f of [0.12, 0.32, 0.55, 0.78, 0.95]) out.push(floor + (roof - floor) * f)
  const extras = polygons.slice(3)
  if (extras.length) {
    const top = Math.max(...extras.flat().map(p => p[1]))
    out.push(top + 1.6, Math.max(roof + 1.2, top - 3))
  }
  return out
}

export class CfdSimulation {
  solver!: LbmSolver
  /** Helper threads for the solver, set by the host when shared memory is available. */
  static threads: { count: (resolution: CfdResolution) => number; spawn: () => ThreadLike } | null = null
  layout!: CfdLayout
  body!: CfdBody
  params: CfdParams
  readonly px = new Float32Array(PARTICLE_CAPACITY)
  readonly py = new Float32Array(PARTICLE_CAPACITY)
  readonly page = new Float32Array(PARTICLE_CAPACITY)
  private alive = new Uint8Array(PARTICLE_CAPACITY)
  /** Which smoke wand released each particle (fixed wands first, then clicked ones). */
  private wand = new Int16Array(PARTICLE_CAPACITY)
  private cursor = 0
  emitters: Vec2[] = []
  private customEmitters: Vec2[] = []
  private cdHistory = new Float64Array(HISTORY_SIZE)
  private clHistory = new Float64Array(HISTORY_SIZE)
  private historyCount = 0
  private historyStartStep = 0
  /** Flow-throughs to wait after the latest change: 1.2 from a fresh start, less for small adjustments of developed flow. */
  private settleTarget = FRESH_SETTLE
  /** Largest re-settle requirement of the changes still being eased in. */
  private pendingSettle = 0
  private emitPhase = 0
  private nextSample = 0
  /** Geometry actually in the tunnel; it eases towards the requested params. */
  private geom!: Geom
  private nextGeometryStep = 0
  private emitterKey = ''
  /** Wall-clock time of the last geometry easing step. */
  private lastGeometryTime = performance.now()
  /** Probe cells two cells off the surface of a lifting section, binned by x/c and side. */
  private probeIndex = new Int32Array(0)
  private probeBin = new Int32Array(0)
  private probeTx = 0
  private probeTy = 0
  private surfaceEma = new Float64Array(2 * SURFACE_BINS)
  private surfaceSamples = 0
  /** Passive smoke concentration for the realistic-smoke display. */
  dye = new Float32Array(0)
  private dyeScratch = new Float32Array(0)
  private dyeScratch2 = new Float32Array(0)
  private dyePhase = 0

  constructor(params: CfdParams) {
    this.params = { ...params }
    this.geom = geomOf(params)
    this.rebuild(true)
  }

  get forceScale(): number { return 0.5 * LATTICE_U * LATTICE_U * this.body.forceLength * this.layout.base }
  get reynoldsLengthCells(): number { return this.body.reynoldsLength * this.layout.base }

  configure(next: CfdParams) {
    const prev = this.params
    this.params = { ...next }
    // A new body or grid starts from clean flow.
    if (prev.resolution !== next.resolution || prev.kind !== next.kind || prev.airfoil !== next.airfoil || prev.flapType !== next.flapType) {
      this.geom = geomOf(next)
      this.rebuild(true)
      return
    }
    // Deploying a slat/flap starts it at 0° and then swings it out smoothly.
    if (prev.slatDeg === null && next.slatDeg !== null) { this.geom.slatDeg = 0; this.rebuild(false) }
    if (prev.flapDeg === null && next.flapDeg !== null) { this.geom.flapDeg = 0; this.rebuild(false) }
    if (next.slatDeg === null && this.geom.slatDeg !== null) { this.geom.slatDeg = null; this.rebuild(false) }
    if (next.flapDeg === null && this.geom.flapDeg !== null) { this.geom.flapDeg = null; this.rebuild(false) }
    // The flow is already developed: wait only as long as the size of this change needs.
    this.pendingSettle = Math.max(this.pendingSettle, resettleFor(prev, next))
    if (prev.reynolds !== next.reynolds) { this.solver.setViscosity(this.latticeViscosity()); this.settleTarget = Math.max(0.6, this.pendingSettle); this.resetHistory() }
    if (prev.smokeLines !== next.smokeLines) this.placeEmitters()
    if (prev.sideRelief !== next.sideRelief) { this.updateRelief(); this.settleTarget = 0.8; this.resetHistory() }
  }

  /** True while the body is still moving towards the requested angles/scale. */
  get transitioning(): boolean { return !sameGeom(this.geom, geomOf(this.params)) }

  /**
   * Moves the current geometry one small step towards the target every 8 lattice
   * steps, at rates defined in wall-clock time (pitch 40°/s, slat/flap/wing 90°/s,
   * scale ×2 per second) so the body keeps up with a slider on any grid. The steps
   * stay small enough that the flow follows instead of shedding an artificial
   * starting vortex.
   */
  private stepGeometry() {
    // Wall-clock time since the last geometry step (capped so a stall can't cause a jump).
    const now = performance.now()
    const perStep = Math.min(0.12, Math.max(0.004, (now - this.lastGeometryTime) / 1000))
    this.lastGeometryTime = now
    const target = geomOf(this.params)
    if (sameGeom(this.geom, target)) { this.lastGeometryTime = performance.now(); return }
    const toward = (from: number, to: number, max: number) => from + Math.max(-max, Math.min(max, to - from))
    const g = this.geom
    g.angleOfAttackDeg = toward(g.angleOfAttackDeg, target.angleOfAttackDeg, Math.min(3, 40 * perStep))
    const swing = Math.min(5, 90 * perStep)
    g.rearWingDeg = toward(g.rearWingDeg, target.rearWingDeg, swing)
    if (g.slatDeg !== null && target.slatDeg !== null) g.slatDeg = toward(g.slatDeg, target.slatDeg, swing)
    if (g.flapDeg !== null && target.flapDeg !== null) g.flapDeg = toward(g.flapDeg, target.flapDeg, swing)
    const ratio = target.scale / g.scale
    const grow = Math.min(1.08, 2 ** perStep)
    g.scale = Math.abs(Math.log(ratio)) <= Math.log(grow) ? target.scale : g.scale * (ratio > 1 ? grow : 1 / grow)
    this.rebuild(false)
  }

  /** Lattice viscosity for the requested Reynolds number, clamped for stability. */
  latticeViscosity(): number {
    return Math.max(MIN_LATTICE_NU, LATTICE_U * this.reynoldsLengthCells / Math.max(1, this.params.reynolds))
  }

  private rebuild(fresh: boolean) {
    const built = { ...this.params, ...this.geom }
    const tunnel = tunnelOf(built)
    this.body = bodyOf(built, tunnel)
    this.layout = layoutBody(this.body, tunnel, built.angleOfAttackDeg)
    const nu = this.latticeViscosity()
    if (fresh || !this.solver || this.solver.nx !== this.layout.nx || this.solver.ny !== this.layout.ny) {
      const { nx, ny } = this.layout
      const band = Math.round(ny * 0.14)
      this.solver?.dispose()
      const threads = CfdSimulation.threads
      this.solver = new LbmSolver({
        nx, ny, inletVelocity: LATTICE_U, viscosity: nu, smagorinsky: 0.16,
        bottom: this.body.onGround ? 'moving' : 'free-slip', top: 'free-slip',
        absorbing: { top: band, bottom: this.body.onGround ? 0 : band, inlet: Math.round(nx * 0.04), outlet: Math.round(nx * 0.1) },
        perturbSteps: 2500,
      }, threads ? { count: threads.count(this.params.resolution), spawn: threads.spawn } : undefined)
      this.solver.setSolid(this.layout.mask, this.layout.linkFractions)
      this.solver.reset()
      this.alive.fill(0)
      // New solver restarts its step count; geometry easing must restart with it.
      this.nextGeometryStep = 0
    } else {
      // Keep the developed flow when only the body moves (e.g. an angle-of-attack change).
      this.solver.setSolid(this.layout.mask, this.layout.linkFractions)
      this.solver.setViscosity(nu)
    }
    if (this.dye.length !== this.layout.nx * this.layout.ny) {
      const n = this.layout.nx * this.layout.ny
      this.dye = new Float32Array(n); this.dyeScratch = new Float32Array(n); this.dyeScratch2 = new Float32Array(n)
    }
    if (fresh) this.dye.fill(0)
    this.buildSurfaceProbes()
    this.updateRelief()
    this.placeEmitters()
    this.settleTarget = fresh ? FRESH_SETTLE : Math.max(MIN_RESETTLE, this.pendingSettle)
    if (fresh || !this.transitioning) this.pendingSettle = 0
    this.resetHistory()
  }

  reset() {
    this.solver.reset()
    this.settleTarget = FRESH_SETTLE
    this.nextGeometryStep = 0
    this.alive.fill(0)
    this.dye.fill(0)
    this.resetHistory()
  }

  /** Builds the side-relief region: around the car and through its near wake, fading out above and behind. */
  private updateRelief() {
    if (!this.params.sideRelief || !this.body.onGround) { this.solver.setRelief(new Int32Array(0), new Float32Array(0)); return }
    const { nx, ny, bounds } = this.layout
    const length = bounds.x1 - bounds.x0
    const height = bounds.y1
    const width = 0.45 * length
    const peak = Math.min(0.5, RELIEF_GAIN * LATTICE_U / Math.max(2, width))
    const start = bounds.x0 - 0.2 * length
    const wake = 4 * length
    const index: number[] = []; const sigma: number[] = []
    for (let y = 0; y < ny; y++) {
      const cy = y + 0.5
      const fy = cy < height ? 1 : Math.max(0, 1 - (cy - height) / (2 * height))
      if (fy <= 0) break
      for (let x = Math.max(0, Math.floor(start)); x < nx; x++) {
        const cx = x + 0.5
        const fx = cx < bounds.x0 ? (cx - start) / (bounds.x0 - start) : cx <= bounds.x1 ? 1 : 1 - (cx - bounds.x1) / wake
        if (fx <= 0) { if (cx > bounds.x1) break; continue }
        index.push(y * nx + x); sigma.push(peak * fy * fx)
      }
    }
    this.solver.setRelief(Int32Array.from(index), Float32Array.from(sigma))
  }

  /** Finds fluid cells exactly two cells (Chebyshev) from the body and bins them along the chord. */
  private buildSurfaceProbes() {
    const chord = this.layout.chord
    if (!chord) { this.probeIndex = new Int32Array(0); this.probeBin = new Int32Array(0); return }
    const { nx, ny } = this.layout
    // Probe only around the main element, so slats and flaps don't read as separation.
    const mask = this.layout.polygons.length > 1 ? rasterize([this.layout.polygons[0]!], nx, ny) : this.layout.mask
    const dist = new Uint8Array(nx * ny).fill(255)
    // Work inside the body's bounding box (+4 cells) only; rebuilds happen often while easing.
    const b = this.layout.bounds
    const bx0 = Math.max(1, Math.floor(b.x0) - 4); const bx1 = Math.min(nx - 2, Math.ceil(b.x1) + 4)
    const by0 = Math.max(1, Math.floor(b.y0) - 4); const by1 = Math.min(ny - 2, Math.ceil(b.y1) + 4)
    for (let y = by0 - 1; y <= by1 + 1; y++) for (let x = bx0 - 1; x <= bx1 + 1; x++) if (mask[y * nx + x]) dist[y * nx + x] = 0
    for (let ring = 1; ring <= 2; ring++) {
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        const i = y * nx + x
        if (dist[i] !== 255) continue
        for (let dy = -1; dy <= 1 && dist[i] === 255; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dist[i + dy * nx + dx] === ring - 1) { dist[i] = ring; break }
        }
      }
    }
    const cx = chord.te[0] - chord.le[0]; const cy = chord.te[1] - chord.le[1]
    const len2 = cx * cx + cy * cy
    const len = Math.sqrt(len2)
    this.probeTx = cx / len; this.probeTy = cy / len
    const index: number[] = []; const bins: number[] = []
    const nxDir = -cy / len; const nyDir = cx / len
    const reach = Math.ceil(Math.hypot(by1 - by0, bx1 - bx0)) + 2
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * nx + x
      if (dist[i] !== 2 || this.layout.mask[i]) continue
      const px = x + 0.5 - chord.le[0]; const py = y + 0.5 - chord.le[1]
      const t = (px * cx + py * cy) / len2
      if (t < 0 || t >= 1) continue
      // Upper side = nothing of the main element above it (towards the left of LE→TE).
      // A chord-line test would count the flap cove under the main element's tail as upper surface.
      let side = 0
      for (let s = 2; s < reach; s++) {
        const qx = Math.floor(x + 0.5 + nxDir * s); const qy = Math.floor(y + 0.5 + nyDir * s)
        if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) break
        if (mask[qy * nx + qx]) { side = 1; break }
      }
      index.push(i); bins.push(side * SURFACE_BINS + Math.min(SURFACE_BINS - 1, Math.floor(t * SURFACE_BINS)))
    }
    this.probeIndex = Int32Array.from(index); this.probeBin = Int32Array.from(bins)
  }

  private sampleSurface() {
    if (!this.probeIndex.length) return
    const sums = new Float64Array(2 * SURFACE_BINS); const counts = new Uint16Array(2 * SURFACE_BINS)
    const { ux, uy } = this.solver
    for (let p = 0; p < this.probeIndex.length; p++) {
      const i = this.probeIndex[p]!; const b = this.probeBin[p]!
      sums[b] = sums[b]! + (ux[i]! * this.probeTx + uy[i]! * this.probeTy) / LATTICE_U
      counts[b] = counts[b]! + 1
    }
    const alpha = this.surfaceSamples === 0 ? 1 : Math.max(SURFACE_EMA, 1 / (this.surfaceSamples + 1))
    for (let b = 0; b < sums.length; b++) {
      if (!counts[b]) continue
      this.surfaceEma[b] = this.surfaceEma[b]! + alpha * (sums[b]! / counts[b]! - this.surfaceEma[b]!)
    }
    this.surfaceSamples++
  }

  private surfaceFlow(side: 0 | 1): SurfaceFlow | null {
    if (!this.probeIndex.length || this.surfaceSamples < 20) return null
    let separation: number | null = null; let reversed = 0
    // Ignore the first 5% (stagnation region) where the tangential direction is ill-defined.
    // Separation = first of two neighbouring bins with clearly reversed flow, so a
    // near-stagnant boundary layer flickering around zero is not reported as a stall.
    const first = Math.ceil(SURFACE_BINS * 0.05)
    const at = (b: number) => this.surfaceEma[side * SURFACE_BINS + b]!
    for (let b = first; b < SURFACE_BINS; b++) {
      if (at(b) < -0.02) reversed++
      if (separation === null && at(b) < -0.03 && (b + 1 >= SURFACE_BINS || at(b + 1) < -0.02)) separation = b / SURFACE_BINS
    }
    return { separation, reversedFraction: reversed / SURFACE_BINS }
  }

  private resetHistory() {
    this.surfaceEma.fill(0)
    this.surfaceSamples = 0
    this.historyCount = 0
    this.historyStartStep = this.solver?.step ?? 0
    this.nextSample = this.historyStartStep
  }

  /**
   * Smoke rake around the model. Positions depend only on the model, grid and the
   * requested scale — not on angles or slat/flap settings — so adjusting the body
   * never shifts the wands and tears the smoke pattern.
   */
  private placeEmitters() {
    const { ny, base } = this.layout
    const requested = Math.max(4, Math.min(80, Math.round(this.params.smokeLines)))
    const plain = bodyOf({ ...this.params, slatDeg: null, flapDeg: null, rearWingDeg: 10 })
    const length = plain.reynoldsLength * base
    const frontal = plain.forceLength * base
    const span = plain.family === 'airfoil' || plain.family === 'plate' ? 1.6 * length : plain.onGround ? Math.max(3.2 * length, 8 * frontal) : 9 * frontal
    const y0 = plain.onGround ? 1.5 : Math.max(1, ny / 2 - span / 2)
    const y1 = plain.onGround ? Math.min(ny - 1, span) : Math.min(ny - 1, ny / 2 + span / 2)
    // Keep wands at least ~4.5 cells apart so neighbouring streams don't merge into fog.
    const lines = Math.max(4, Math.min(requested, Math.floor((y1 - y0) / 4.5)))
    // Cars: add wands aimed at the car itself (the gap under the floor, nose, hood, windshield,
    // roof, and either side of a spoiler or wing) so smoke visibly hits the car and splits
    // over and under it, even when the evenly spaced wands miss those heights.
    let aimed: number[] = []
    if (plain.onGround && this.layout.polygons[0]) {
      // The reference model (spoiler/wing at a fixed 10°) in cells, lifted like the live layout.
      const shift = Math.min(...this.layout.polygons[0].map(p => p[1])) - Math.min(...plain.polygons[0]!.map(p => p[1])) * base
      aimed = carWandHeights(plain.polygons.map(poly => poly.map(([x, y]) => [x * base, y * base + shift] as Vec2)))
    }
    const key = `${lines}|${y0.toFixed(1)}|${y1.toFixed(1)}|${aimed.map(y => y.toFixed(1)).join(',')}`
    if (key !== this.emitterKey) {
      this.emitterKey = key
      const even = Array.from({ length: lines }, (_, i) => y0 + (y1 - y0) * (i + 0.5) / lines).filter(y => aimed.every(a => Math.abs(a - y) > 2.2))
      this.emitters = [...even, ...aimed].sort((a, b) => a - b).map(y => [1.2, y] as Vec2)
    }
    this.customEmitters = this.customEmitters.filter(([x, y]) => x < this.layout.nx && y < ny)
  }

  /**
   * Lays smoke along every wand's line across the whole tunnel, as if it had been
   * flowing for a while, so a fresh view is populated immediately.
   */
  prefillSmoke() {
    const spacing = LATTICE_U * Math.max(1, this.params.smokeEmitEvery ?? 5)
    const { nx } = this.layout
    const solid = this.solver.solid
    for (const [k, [x0, y]] of this.emitters.entries()) {
      for (let x = nx - 2; x > x0; x -= spacing) {
        if (solid[Math.floor(y) * nx + Math.floor(x)]) continue
        this.spawn(x, y, k)
        this.page[(this.cursor + PARTICLE_CAPACITY - 1) % PARTICLE_CAPACITY] = (x - x0) / LATTICE_U
      }
    }
  }

  addEmitter(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.layout.nx || y >= this.layout.ny) return
    if (this.customEmitters.length >= 24) this.customEmitters.shift()
    this.customEmitters.push([x, y])
  }

  clearEmitters() { this.customEmitters = [] }
  get emitterPoints(): readonly Vec2[] { return this.customEmitters }

  /** Advance the flow by `steps` lattice steps, moving smoke along with it. */
  advance(steps: number, smoke: SmokeMode | boolean = 'particles'): boolean {
    const mode: SmokeMode = smoke === true ? 'particles' : smoke === false ? 'none' : smoke
    const chunk = 4
    for (let done = 0; done < steps && !this.solver.diverged; done += chunk) {
      const n = Math.min(chunk, steps - done)
      this.solver.run(n)
      if (this.solver.step >= this.nextGeometryStep) { this.nextGeometryStep = this.solver.step + 8; this.stepGeometry() }
      this.recordForces()
      if (mode === 'particles') { this.emit(n); this.advect(n) }
      else if (mode === 'dye') { this.dyePhase += n; if (this.dyePhase >= 5) { this.advectDye(this.dyePhase); this.dyePhase = 0 } }
    }
    return !this.solver.diverged
  }

  /** Bilinear sample of a cell-centred scalar; also returns the min/max of the four corners. */
  private sampleScalar(field: Float32Array, x: number, y: number, out: Float64Array) {
    const { nx, ny } = this.layout
    const fx = Math.min(nx - 1.001, Math.max(0, x - 0.5))
    const fy = Math.min(ny - 1.001, Math.max(0, y - 0.5))
    const i0 = Math.floor(fx); const j0 = Math.floor(fy)
    const tx = fx - i0; const ty = fy - j0
    const a = j0 * nx + i0
    const v00 = field[a]!; const v10 = field[a + 1]!; const v01 = field[a + nx]!; const v11 = field[a + nx + 1]!
    out[0] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
    out[1] = Math.min(v00, v10, v01, v11); out[2] = Math.max(v00, v10, v01, v11)
  }

  /**
   * Semi-Lagrangian MacCormack advection of smoke concentration (second order,
   * limited to stay bounded), then re-seed the smoke wands. Diffusion is purely
   * numerical, which mimics the soft edges of real tunnel smoke.
   */
  private advectDye(dt: number) {
    const { nx, ny } = this.layout
    const { ux, uy, solid } = this.solver
    const phi = this.dye; const hat = this.dyeScratch; const out = this.dyeScratch2
    const tmp = new Float64Array(3)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = y * nx + x
      if (solid[i]) { hat[i] = 0; continue }
      this.sampleScalar(phi, x + 0.5 - dt * ux[i]!, y + 0.5 - dt * uy[i]!, tmp)
      hat[i] = tmp[0]!
    }
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = y * nx + x
      if (solid[i]) { out[i] = 0; continue }
      this.sampleScalar(hat, x + 0.5 + dt * ux[i]!, y + 0.5 + dt * uy[i]!, tmp)
      const corrected = hat[i]! + 0.5 * (phi[i]! - tmp[0]!)
      this.sampleScalar(phi, x + 0.5 - dt * ux[i]!, y + 0.5 - dt * uy[i]!, tmp)
      out[i] = Math.min(tmp[2]!, Math.max(tmp[1]!, corrected)) * 0.9995
    }
    this.dye.set(out)
    // Smoke wands: thin streams released just inside the inlet, plus user injectors.
    const seed = (sx: number, sy: number, radius: number) => {
      const x0 = Math.max(0, Math.floor(sx - radius)); const x1 = Math.min(nx - 1, Math.ceil(sx + radius))
      const y0 = Math.max(0, Math.floor(sy - radius)); const y1 = Math.min(ny - 1, Math.ceil(sy + radius))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d2 = (x + 0.5 - sx) ** 2 + (y + 0.5 - sy) ** 2
        const i = y * nx + x
        if (!solid[i]) this.dye[i] = Math.max(this.dye[i]!, Math.exp(-d2 / (radius * radius * 0.5)))
      }
    }
    const radius = Math.max(0.9, this.layout.base / 70)
    for (const [x, y] of this.emitters) seed(x + 1.5, y, radius)
    for (const [x, y] of this.customEmitters) seed(x, y, radius * 1.2)
  }

  /** Smoke concentration quantised to bytes for transfer to the renderer. */
  dyeBytes(): Uint8Array {
    const out = new Uint8Array(this.dye.length)
    for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.round(this.dye[i]! * 255))
    return out
  }

  private recordForces() {
    const s = this.solver
    if (s.step < this.nextSample) return
    this.nextSample = s.step + HISTORY_EVERY
    const slot = this.historyCount % HISTORY_SIZE
    this.cdHistory[slot] = s.forceX / this.forceScale
    this.clHistory[slot] = s.forceY / this.forceScale
    this.historyCount++
    this.sampleSurface()
  }

  private spawn(x: number, y: number, wand: number) {
    const i = this.cursor
    this.px[i] = x; this.py[i] = y; this.page[i] = 0; this.alive[i] = 1; this.wand[i] = wand
    this.cursor = (i + 1) % PARTICLE_CAPACITY
  }

  private emit(steps: number) {
    // One puff per emitter every few lattice steps (0.5 cells of travel at the default 5).
    const every = Math.max(1, this.params.smokeEmitEvery ?? 5)
    this.emitPhase += steps
    while (this.emitPhase >= every) {
      this.emitPhase -= every
      this.emitters.forEach(([x, y], k) => this.spawn(x, y, k))
      this.customEmitters.forEach(([x, y], k) => this.spawn(x, y, this.emitters.length + k))
    }
  }

  /** Bilinear velocity at a lattice position (cell centres at i + 0.5). */
  velocityAt(x: number, y: number): [number, number] {
    const { nx, ny } = this.layout
    const fx = Math.min(nx - 1.001, Math.max(0, x - 0.5))
    const fy = Math.min(ny - 1.001, Math.max(0, y - 0.5))
    const i0 = Math.floor(fx); const j0 = Math.floor(fy)
    const tx = fx - i0; const ty = fy - j0
    const a = j0 * nx + i0; const b = a + 1; const c = a + nx; const d = c + 1
    const { ux, uy } = this.solver
    const w00 = (1 - tx) * (1 - ty); const w10 = tx * (1 - ty); const w01 = (1 - tx) * ty; const w11 = tx * ty
    return [ux[a]! * w00 + ux[b]! * w10 + ux[c]! * w01 + ux[d]! * w11, uy[a]! * w00 + uy[b]! * w10 + uy[c]! * w01 + uy[d]! * w11]
  }

  private advect(dt: number) {
    const { nx, ny } = this.layout
    const solid = this.solver.solid
    for (let i = 0; i < PARTICLE_CAPACITY; i++) {
      if (!this.alive[i]) continue
      const x = this.px[i]!; const y = this.py[i]!
      const [u1, v1] = this.velocityAt(x, y)
      const [u2, v2] = this.velocityAt(x + 0.5 * dt * u1, y + 0.5 * dt * v1)
      const nxp = x + dt * u2; const nyp = y + dt * v2
      if (nxp >= nx - 0.5 || nxp < 0 || nyp < 0 || nyp >= ny) { this.alive[i] = 0; continue }
      if (solid[Math.floor(nyp) * nx + Math.floor(nxp)]) continue
      this.px[i] = nxp; this.py[i] = nyp; this.page[i] = this.page[i]! + dt
    }
  }

  /**
   * Live smoke particles as [x, y, age, wand] quadruples, grouped by wand and, within a
   * wand, newest first (release order), so the renderer can join each wand's particles
   * into one continuous streakline.
   */
  particles(): Float32Array {
    const wands = this.emitters.length + this.customEmitters.length
    const counts = new Int32Array(wands + 1)
    for (let i = 0; i < PARTICLE_CAPACITY; i++) if (this.alive[i]) counts[Math.min(wands, this.wand[i]!)]!++
    const starts = new Int32Array(wands + 2)
    for (let w = 0; w <= wands; w++) starts[w + 1] = starts[w]! + counts[w]!
    const out = new Float32Array(starts[wands + 1]! * 4)
    const fill = starts.slice()
    // Walk the ring buffer from the newest particle back to the oldest.
    for (let k = 1; k <= PARTICLE_CAPACITY; k++) {
      const i = (this.cursor - k + PARTICLE_CAPACITY) % PARTICLE_CAPACITY
      if (!this.alive[i]) continue
      const w = Math.min(wands, this.wand[i]!)
      const o = fill[w]!++ * 4
      out[o] = this.px[i]!; out[o + 1] = this.py[i]!; out[o + 2] = this.page[i]!; out[o + 3] = w
    }
    return out
  }

  stats(): CfdStats {
    const s = this.solver
    const count = Math.min(this.historyCount, HISTORY_SIZE)
    const flowThroughs = (s.step - this.historyStartStep) * LATTICE_U / this.layout.nx
    const settled = flowThroughs > this.settleTarget
    // Statistics use samples recorded after most of the transient has passed: the first ~85%
    // of a fresh start, the first 60% of a short re-settle (a longer window steadies the
    // early reading). The window keeps growing afterwards, so the averages keep refining.
    const flush = this.settleTarget >= FRESH_SETTLE ? 0.85 : 0.6
    const transient = Math.ceil(flush * this.settleTarget * this.layout.nx / LATTICE_U / HISTORY_EVERY)
    const usable = settled ? Math.max(1, Math.min(count, this.historyCount - transient)) : 1
    const at = (k: number) => (this.historyCount - usable + k + HISTORY_SIZE * 4) % HISTORY_SIZE
    let cdSum = 0; let clSum = 0
    for (let k = 0; k < usable; k++) { cdSum += this.cdHistory[at(k)]!; clSum += this.clHistory[at(k)]! }
    const cdMean = cdSum / usable; const clMean = clSum / usable
    let cdVar = 0; let clVar = 0
    for (let k = 0; k < usable; k++) {
      const dcd = this.cdHistory[at(k)]! - cdMean; const dcl = this.clHistory[at(k)]! - clMean
      cdVar += dcd * dcd; clVar += dcl * dcl
    }
    const clStd = Math.sqrt(clVar / usable)
    // Shedding frequency from the spacing of upward mean-crossings of the lift history.
    let first = -1; let last = -1; let crossings = 0
    for (let k = 1; k < usable; k++) {
      const a = this.clHistory[at(k - 1)]! - clMean; const b = this.clHistory[at(k)]! - clMean
      if (a < 0 && b >= 0) { const t = k - 1 + a / (a - b); if (first < 0) first = t; last = t; crossings++ }
    }
    const period = crossings >= 3 ? (last - first) / (crossings - 1) * HISTORY_EVERY : 0
    const strouhal = settled && period > 0 && clStd > 0.01 ? this.body.forceLength * this.layout.base / (period * LATTICE_U) : null
    const nu = this.latticeViscosity()
    return {
      step: s.step, flowThroughs, settled, settleFlowThroughs: this.settleTarget,
      cd: s.forceX / this.forceScale, cl: s.forceY / this.forceScale,
      cdMean, clMean, cdStd: Math.sqrt(cdVar / usable), clStd, strouhal,
      reynolds: LATTICE_U * this.reynoldsLengthCells / nu,
      maxReynolds: Math.floor(LATTICE_U * this.reynoldsLengthCells / MIN_LATTICE_NU),
      blockage: this.layout.blockage, latticeNu: nu, tau: 3 * nu + 0.5, diverged: s.diverged,
      forceLengthLabel: this.body.forceLengthLabel,
      ...this.surfaceSides(clMean),
    }
  }

  private surfaceSides(clMean: number): { suction: SurfaceFlow | null; pressureSide: SurfaceFlow | null } {
    const upper = this.surfaceFlow(0); const lower = this.surfaceFlow(1)
    // Suction side is the one lift pulls towards; at negative incidence that is the lower surface.
    const upperIsSuction = this.params.angleOfAttackDeg > 0.5 || (Math.abs(this.params.angleOfAttackDeg) <= 0.5 && clMean >= 0)
    return upperIsSuction ? { suction: upper, pressureSide: lower } : { suction: lower, pressureSide: upper }
  }

  /** Recent Cd/Cl samples, oldest first. */
  history(maxSamples = 160): { cd: Float32Array; cl: Float32Array } {
    const count = Math.min(this.historyCount, HISTORY_SIZE, maxSamples)
    const cd = new Float32Array(count); const cl = new Float32Array(count)
    for (let k = 0; k < count; k++) {
      const slot = (this.historyCount - count + k + HISTORY_SIZE * 4) % HISTORY_SIZE
      cd[k] = this.cdHistory[slot]!; cl[k] = this.clHistory[slot]!
    }
    return { cd, cl }
  }
}
