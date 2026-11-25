import type { ModelKind } from '../../types/index.ts'

export type Vec2 = [number, number]

export type AirfoilCode = '0012' | '2412' | '4412' | '0006' | '6409'
export const airfoilOptions: readonly { value: AirfoilCode; label: string }[] = [
  { value: '0012', label: 'NACA 0012 · symmetric' },
  { value: '2412', label: 'NACA 2412 · light camber' },
  { value: '4412', label: 'NACA 4412 · high lift' },
  { value: '6409', label: 'NACA 6409 · thin, high camber' },
  { value: '0006', label: 'NACA 0006 · thin symmetric' },
]

/**
 * A 2D body for the lattice Boltzmann tunnel, in body units where 1 equals the
 * solver's base length B (cells). x points downstream and y points up.
 */
export interface CfdBody {
  polygons: Vec2[][]
  /** Length used for Reynolds number (chord, diameter, or vehicle length). */
  reynoldsLength: number
  /** Length used to normalise forces (chord for lifting sections, frontal height for bluff bodies). */
  forceLength: number
  forceLengthLabel: string
  /** True when the body sits on a moving ground plane. */
  onGround: boolean
  /** True when angle of attack is applied as a pitch rotation. */
  pitchable: boolean
  description: string
  /** Chord line in body units for lifting sections (used for separation analysis). */
  chord?: { le: Vec2; te: Vec2 }
  /** Kind of flow-behaviour description that applies. */
  family: 'airfoil' | 'plate' | 'bluff' | 'vehicle'
  /**
   * Polygons drawn for reference but not solid in the flow (a car's wheels: they sit at
   * the sides, so a centreline slice passes between them and air flows under the floor).
   */
  visualOnly?: number[]
  /** What each polygon is (for colouring); defaults to 'main'. */
  roles?: ElementRole[]
}

export type ElementRole = 'main' | 'slat' | 'flap'

/** Upper and lower NACA 4-digit surfaces, chord 1, both ordered from leading to trailing edge. */
export function naca4Surfaces(code: string, points = 90): { upper: Vec2[]; lower: Vec2[] } {
  const m = Number(code[0]) / 100
  const p = Number(code[1]) / 10
  const t = Number(code.slice(2)) / 100
  const upper: Vec2[] = []
  const lower: Vec2[] = []
  for (let i = 0; i <= points; i++) {
    const x = 0.5 * (1 - Math.cos(Math.PI * i / points))
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    let yc = 0
    let dyc = 0
    if (m > 0 && p > 0) {
      if (x < p) { yc = m / (p * p) * (2 * p * x - x * x); dyc = 2 * m / (p * p) * (p - x) }
      else { yc = m / ((1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x); dyc = 2 * m / ((1 - p) ** 2) * (p - x) }
    }
    const th = Math.atan(dyc)
    upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)])
    lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)])
  }
  return { upper, lower }
}

/** NACA 4-digit section with cosine spacing and a closed trailing edge, chord 1, leading edge at the origin. */
export function naca4(code: string, points = 90): Vec2[] {
  const { upper, lower } = naca4Surfaces(code, points)
  // Counter-clockwise loop: trailing edge → upper surface → leading edge → lower surface.
  return [...upper.slice().reverse(), ...lower.slice(1, -1)]
}

/** Linear interpolation of a surface (ordered by x) at chord station x. */
function surfaceY(surface: Vec2[], x: number): number {
  for (let i = 1; i < surface.length; i++) {
    const a = surface[i - 1]!; const b = surface[i]!
    if (x <= b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / Math.max(1e-9, b[0] - a[0])
  }
  return surface[surface.length - 1]![1]
}

function pointInPolygon([px, py]: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!; const b = poly[j]!
    if ((a[1] > py) !== (b[1] > py) && px < a[0] + (py - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside
  }
  return inside
}

function pointSegmentDistance([px, py]: Vec2, [ax, ay]: Vec2, [bx, by]: Vec2): number {
  const dx = bx - ax; const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(1e-12, dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** Smallest distance between two closed polygons, or 0 if they overlap. */
export function polygonGap(a: Vec2[], b: Vec2[]): number {
  // Only edges near the other polygon can set the gap; skip the rest.
  const box = (poly: Vec2[], pad: number) => {
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
    for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    return { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad }
  }
  type Edge = [Vec2, Vec2] & { box?: [number, number, number, number] }
  const near = (poly: Vec2[], r: { x0: number; x1: number; y0: number; y1: number }) => {
    const edges: Edge[] = []
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p = poly[j]!; const q = poly[i]!
      if (Math.max(p[0], q[0]) < r.x0 || Math.min(p[0], q[0]) > r.x1 || Math.max(p[1], q[1]) < r.y0 || Math.min(p[1], q[1]) > r.y1) continue
      const e = [p, q] as Edge
      e.box = [Math.min(p[0], q[0]), Math.max(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[1], q[1])]
      edges.push(e)
    }
    return edges
  }
  // Only distances below `pad` matter to callers, so skip edges whose box is further than the best so far.
  const closest = (p: Vec2, edges: Edge[], best: number) => {
    for (const e of edges) {
      const [x0, x1, y0, y1] = e.box!
      if (p[0] < x0 - best || p[0] > x1 + best || p[1] < y0 - best || p[1] > y1 + best) continue
      best = Math.min(best, pointSegmentDistance(p, e[0], e[1]))
    }
    return best
  }
  const pad = 4 * SLOT_GAP
  const ra = box(a, pad); const rb = box(b, pad)
  const edgesA = near(a, rb); const edgesB = near(b, ra)
  const inside = (p: Vec2, r: { x0: number; x1: number; y0: number; y1: number }) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1
  // Thin elements can cross without either one's vertices landing inside the other.
  const cross = (p: Vec2, q: Vec2, r: Vec2, t: Vec2) => {
    const d = (a1: Vec2, a2: Vec2, a3: Vec2) => (a2[0] - a1[0]) * (a3[1] - a1[1]) - (a2[1] - a1[1]) * (a3[0] - a1[0])
    return d(p, q, r) * d(p, q, t) < 0 && d(r, t, p) * d(r, t, q) < 0
  }
  let best = pad
  for (const p of a) {
    if (!inside(p, rb)) continue
    if (pointInPolygon(p, b)) return 0
    best = closest(p, edgesB, best)
  }
  for (const p of b) {
    if (!inside(p, ra)) continue
    if (pointInPolygon(p, a)) return 0
    best = closest(p, edgesA, best)
  }
  // Crossing edges imply vertices within an edge length of each other, so only check when close.
  if (best < 0.04) {
    const near = (e: [Vec2, Vec2]) => Math.min(e[0][0], e[1][0]) <= rb.x1 && Math.max(e[0][0], e[1][0]) >= rb.x0
    for (const [p, q] of edgesA) for (const [r, t] of edgesB) if (near([p, q]) && cross(p, q, r, t)) return 0
  }
  return best
}

/**
 * Places `shape` (whose reference point sits at height 0) starting from `startY` and
 * moving along `direction` until it is exactly SLOT_GAP clear of `main`.
 */
function clearOf(shape: Vec2[], obstacles: Vec2[][], direction: Vec2, startY: number, hintKey: string, gap = SLOT_GAP): Vec2[] {
  const at = (d: number) => shape.map(([x, y]) => [x + direction[0] * d, y + startY + direction[1] * d] as Vec2)
  // A zero gap means "stowed": leave the element in its designed, flush position.
  if (gap <= 1e-6) return at(0)
  const tight = (d: number) => { const placed = at(d); return obstacles.some(o => polygonGap(placed, o) < gap) }
  // While a slider eases, consecutive solutions are close: start from the last one.
  const hint = clearanceHints.get(hintKey)
  let lo = 0; let hi = 0.01
  if (hint !== undefined && tight(Math.max(-0.3, hint - 0.004)) && !tight(hint + 0.004)) { lo = Math.max(-0.3, hint - 0.004); hi = hint + 0.004 }
  else if (!tight(0)) {
    // Already clear: step back towards the obstacle until the slot is too narrow.
    hi = 0; lo = -0.01
    while (!tight(lo) && lo > -0.2) { hi = lo; lo -= 0.01 }
    if (!tight(lo)) { clearanceHints.set(hintKey, 0); return at(0) }
  } else while (tight(hi) && hi < 0.8) { lo = hi; hi += 0.01 }
  for (let k = 0; k < 10; k++) { const mid = (lo + hi) / 2; if (tight(mid)) lo = mid; else hi = mid }
  clearanceHints.set(hintKey, hi)
  return at(hi)
}
const clearanceHints = new Map<string, number>()

function circle(cx: number, cy: number, r: number, segments = 72): Vec2[] {
  return Array.from({ length: segments }, (_, i) => {
    const a = 2 * Math.PI * i / segments
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Vec2
  })
}

function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

function transform(points: Vec2[], scale: number, angleRad: number, pivot: Vec2, offset: Vec2): Vec2[] {
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  return points.map(([x, y]) => {
    const px = (x - pivot[0]) * scale
    const py = (y - pivot[1]) * scale
    return [px * c - py * s + offset[0], px * s + py * c + offset[1]] as Vec2
  })
}

/** Small inverted wing element used on the race and big-wing cars. */
function rearWing(chord: number, x: number, y: number, angleDeg: number): Vec2[] {
  const section = naca4('6409', 40).map(([px, py]) => [px, -py] as Vec2)
  // Positive angle drops the leading edge, as on a downforce wing.
  return transform(section, chord, angleDeg * Math.PI / 180, [0, 0], [x, y])
}

const carBodies: Record<'suv' | 'coupe' | 'sports', Vec2[]> = {
  suv: [[0, 0.1], [0.008, 0.2], [0.04, 0.265], [0.2, 0.29], [0.3, 0.425], [0.335, 0.445], [0.92, 0.445], [0.975, 0.42], [1, 0.36], [1, 0.13], [0.975, 0.085], [0.03, 0.085]],
  coupe: [[0, 0.085], [0.01, 0.165], [0.06, 0.205], [0.3, 0.245], [0.42, 0.355], [0.5, 0.372], [0.68, 0.355], [0.86, 0.27], [1, 0.24], [1, 0.13], [0.97, 0.075], [0.03, 0.07]],
  // Low sports coupe: long low hood, windshield raked back ~27°, low roof, fastback to a short deck (spoiler/wing mount at x 0.9).
  sports: [[0, 0.075], [0.006, 0.104], [0.03, 0.13], [0.1, 0.15], [0.22, 0.167], [0.36, 0.184], [0.43, 0.22], [0.5, 0.252], [0.56, 0.264], [0.64, 0.262], [0.75, 0.236], [0.86, 0.206], [0.9, 0.2], [0.97, 0.197], [1, 0.184], [1, 0.11], [0.985, 0.075], [0.95, 0.06], [0.05, 0.06], [0.015, 0.064]],
}

export interface BodyOptions {
  airfoil: AirfoilCode
  /** Uniform model scale: 1 = chord or car length of one base unit B. */
  scale: number
  /** Rear spoiler / wing incidence for cars, degrees (positive = more downforce). */
  rearWingDeg: number
  /** Leading-edge slat deflection in degrees, or null when retracted/absent. */
  slatDeg: number | null
  /** Trailing-edge flap deflection in degrees, or null when absent. */
  flapDeg: number | null
  flapType: FlapType
}

export const defaultBodyOptions: BodyOptions = { airfoil: '2412', scale: 1, rearWingDeg: 10, slatDeg: null, flapDeg: null, flapType: 'double' }

export const hasRearWing = (kind: ModelKind) => kind === 'spoiler' || kind === 'wing' || kind === 'race'

/** Slot width between high-lift elements, as a fraction of chord. */
export const SLOT_GAP = 0.03

export type FlapType = 'single' | 'double'

/** Quadratic Bézier from a through control c to b, excluding a. */
function bezier(a: Vec2, c: Vec2, b: Vec2, segments: number): Vec2[] {
  return Array.from({ length: segments }, (_, i) => {
    const t = (i + 1) / segments
    const u = 1 - t
    return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]] as Vec2
  })
}

/** Offsets an open contour along its left-hand normals by thickness(i). */
function offsetContour(contour: Vec2[], thickness: (i: number) => number): Vec2[] {
  return contour.map((p, i) => {
    const a = contour[Math.max(0, i - 1)]!; const b = contour[Math.min(contour.length - 1, i + 1)]!
    const tx = b[0] - a[0]; const ty = b[1] - a[1]; const len = Math.hypot(tx, ty) || 1
    // Contours here run anticlockwise round the section, so (-ty, tx) points inward.
    return [p[0] - ty / len * thickness(i), p[1] + tx / len * thickness(i)] as Vec2
  })
}

/** Slot width grows from 0 (stowed, sealed) to SLOT_GAP over the first few degrees of deployment. */
const deployGap = (deg: number) => SLOT_GAP * Math.min(1, Math.max(0, deg) / 6)

/** Slat chord-wise extent on the upper and lower surface. */
const SLAT_UPPER = 0.15
const SLAT_LOWER = 0.04
/** Main-element cove (start of the flap well) and shroud thickness. */
const COVE_X = 0.6
const SHROUD = 0.016

/**
 * Airliner high-lift section (after the classic slat + double-slotted-flap layout):
 * - Stowed (0°), the slat is the airfoil's own nose and the flaps fill the cove under
 *   the main element's long, thin trailing-edge shroud, so the section is the clean airfoil.
 * - The slat slides forward and droops nose-down, opening a slot behind it.
 * - The fore flap runs aft and down on its track; the smaller aft flap deflects further.
 * Each slot opens to SLOT_GAP within the first few degrees and stays exactly that wide.
 */
function highLiftSection(code: AirfoilCode, slatDeg: number | null, flapDeg: number | null, flapType: FlapType): { polygons: Vec2[][]; roles: ElementRole[] } {
  const { upper, lower } = naca4Surfaces(code, 110)
  const hasSlat = slatDeg !== null
  const hasFlap = flapDeg !== null
  // Nose contour shared by the slat (outside) and the main element (inside).
  const nose: Vec2[] = [...upper.filter(([x]) => x <= SLAT_UPPER).reverse(), ...lower.filter(([x]) => x > 0 && x <= SLAT_LOWER)]
  const slatThickness = (i: number) => 0.024 * Math.sin(Math.PI * Math.min(1, (i + 0.5) / nose.length)) ** 0.6
  const mainNose = offsetContour(nose, slatThickness)

  // Main element.
  const topAft = upper.filter(([x]) => x > (hasSlat ? SLAT_UPPER : 0))
  const lowerFrom = hasSlat ? SLAT_LOWER : 0
  let main: Vec2[]
  let ceiling: Vec2[] = []
  if (!hasFlap) {
    const bottom = lower.filter(([x]) => x > lowerFrom && x < 1)
    main = hasSlat ? [...topAft.slice().reverse(), ...mainNose, ...bottom] : naca4(code, 110)
  } else {
    const bottom = lower.filter(([x]) => x > lowerFrom && x < COVE_X)
    const shroudStart = COVE_X + 0.09
    // Cove rises from the lower surface into a shroud that follows the upper surface to the trailing edge.
    const cove = bezier([COVE_X, surfaceY(lower, COVE_X)], [COVE_X + 0.02, surfaceY(upper, shroudStart) - SHROUD * 1.6], [shroudStart, surfaceY(upper, shroudStart) - SHROUD], 20)
    const shroud: Vec2[] = upper.filter(([x]) => x > shroudStart && x < 0.995).map(([x, y]) => [x, y - SHROUD * (1 - 0.7 * (x - shroudStart) / (1 - shroudStart))] as Vec2)
    const noseLoop = hasSlat ? mainNose : [...upper.filter(([x]) => x <= 0.002).reverse()]
    main = [...topAft.slice().reverse(), ...noseLoop, ...bottom, [COVE_X, surfaceY(lower, COVE_X)], ...cove, ...shroud]
    if (!hasSlat) main = [...upper.slice().reverse(), ...bottom.filter(([x]) => x > 0), [COVE_X, surfaceY(lower, COVE_X)], ...cove, ...shroud]
    // Ceiling of the flap well: cove, then shroud underside, then the trailing edge.
    ceiling = [[COVE_X, surfaceY(lower, COVE_X)], ...cove, ...shroud, [1, surfaceY(upper, 1)]]
  }
  const polygons: Vec2[][] = [main]
  const roles: ElementRole[] = ['main']

  if (hasSlat) {
    const crescent = [...nose, ...mainNose.slice().reverse()]
    const tail = nose[0]!
    const drooped = transform(crescent, 1, slatDeg * Math.PI / 180, tail, tail)
    // Track: forward and slightly down; the clearance search sets the exact slot width.
    const travel = Math.min(1, Math.max(0, slatDeg) / 30)
    const forward = drooped.map(([x, y]) => [x - 0.025 * travel, y - 0.01 * travel] as Vec2)
    polygons.push(clearOf(forward, [main], [-0.97, -0.24], 0, `slat|${code}|${hasFlap}`, deployGap(slatDeg)))
    roles.push('slat')
  }
  if (hasFlap) {
    const deg = Math.max(0, flapDeg)
    const travel = Math.min(1, deg / 40)
    const gap = deployGap(deg)
    const ceilingY = (x: number) => surfaceY(ceiling, x)
    /**
     * Flap that stows flush in the well: its underside is the wing's lower surface and
     * its top a rounded airfoil-like hump that just fills the space under the ceiling.
     */
    const stowedFlap = (a: number, b: number): Vec2[] => {
      const f = (t: number) => 0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4
      // Size the hump on the flap's front half, then clip the tail under the ceiling.
      let peak = Infinity
      for (let k = 4; k <= 24; k++) {
        const t = k / 40; const x = a + (b - a) * t
        peak = Math.min(peak, (ceilingY(x) - 0.004 - surfaceY(lower, x)) / (f(t) / 0.1513))
      }
      // Real flaps are slender: at most 12% thick.
      peak = Math.min(peak, 0.12 * (b - a))
      const n = 30
      const bottom: Vec2[] = []; const top: Vec2[] = []
      for (let k = 0; k <= n; k++) {
        const t = 0.5 * (1 - Math.cos(Math.PI * k / n)); const x = a + (b - a) * t; const y = surfaceY(lower, x)
        const room = Math.max(0.0015, ceilingY(x) - 0.003 - y)
        bottom.push([x, y]); top.push([x, y + Math.min(room, Math.max(0, peak) * f(t) / 0.1513)])
      }
      return [...bottom, ...top.slice(1, -1).reverse()]
    }
    // Deploy: rotate trailing-edge-down about the flap nose, run aft along the track,
    // then drop until the slot is exactly `gap` wide.
    const deploy = (shape: Vec2[], angle: number, aft: number, key: string, obstacles: Vec2[][]) => {
      const noseP = shape[0]!
      const turned = transform(shape, 1, -angle * Math.PI / 180, noseP, [noseP[0] + aft, 0])
      return clearOf(turned, obstacles, [0, -1], noseP[1], key, gap)
    }
    const split = flapType === 'double' ? 0.845 : 0.99
    const fore = deploy(stowedFlap(COVE_X + 0.025, split), deg, 0.13 * travel, `fore|${code}|${flapType}|${hasSlat}`, [main])
    polygons.push(fore); roles.push('flap')
    if (flapType === 'double') {
      // Aft flap rides behind the fore flap and deflects about 1.6× as far.
      const aftStowed = stowedFlap(split + 0.008, 0.99)
      const foreTail = fore.reduce((a, p) => p[0] > a[0] ? p : a)
      const shift = travel > 0 ? [foreTail[0] - 0.035 - aftStowed[0]![0], foreTail[1] + 0.01 - aftStowed[0]![1]] : [0, 0]
      const moved = aftStowed.map(([x, y]) => [x + shift[0]!, y + shift[1]!] as Vec2)
      const noseP = moved[0]!
      const turned = transform(moved, 1, -Math.min(60, 1.6 * deg) * Math.PI / 180, noseP, [noseP[0], 0])
      const aft = clearOf(turned, [main, fore], [0, -1], noseP[1], `aft|${code}|${hasSlat}`, gap)
      polygons.push(aft); roles.push('flap')
    }
  }
  return { polygons, roles }
}

function scaleBody(body: CfdBody, scale: number): CfdBody {
  const k = (points: Vec2[]) => points.map(([x, y]) => [x * scale, y * scale] as Vec2)
  return {
    ...body,
    polygons: body.polygons.map(k),
    reynoldsLength: body.reynoldsLength * scale,
    forceLength: body.forceLength * scale,
    chord: body.chord ? { le: k([body.chord.le])[0]!, te: k([body.chord.te])[0]! } : undefined,
  }
}

/** Builds the 2D body for a model kind. Car shapes are side profiles, everything else a cross-section. */
export function cfdBodyFor(kind: ModelKind, options: Partial<BodyOptions> = {}): CfdBody {
  const o = { ...defaultBodyOptions, ...options }
  return scaleBody(unscaledBody(kind, o), Math.max(0.05, o.scale))
}

function unscaledBody(kind: ModelKind, o: BodyOptions): CfdBody {
  const base = { onGround: false, pitchable: true }
  switch (kind) {
    case 'aircraft-wing': {
      const highLift = o.slatDeg !== null || o.flapDeg !== null
      const section = highLift ? highLiftSection(o.airfoil, o.slatDeg, o.flapDeg, o.flapType) : { polygons: [naca4(o.airfoil)], roles: ['main'] as ElementRole[] }
      const polygons = section.polygons.map(poly => poly.map(([x, y]) => [x - 0.25, y] as Vec2))
      const extras = [o.slatDeg !== null ? `slat ${o.slatDeg}°` : '', o.flapDeg !== null ? `${o.flapType === 'double' ? 'double-slotted ' : ''}flap ${o.flapDeg}°` : ''].filter(Boolean).join(', ')
      return { ...base, family: 'airfoil', chord: { le: [-0.25, 0], te: [0.75, 0] }, polygons, reynoldsLength: 1, forceLength: 1, forceLengthLabel: 'chord', roles: section.roles, description: `NACA ${o.airfoil} section${extras ? ` with ${extras}` : ''}, pitched about quarter chord` }
    }
    case 'plate':
      return { ...base, family: 'plate', chord: { le: [-0.4, 0], te: [0.4, 0] }, polygons: [rect(-0.4, -0.02, 0.4, 0.02)], reynoldsLength: 0.8, forceLength: 0.8, forceLengthLabel: 'plate length', description: 'Thin flat plate, 5% thick' }
    case 'cylinder':
    case 'sphere':
      return { ...base, family: 'bluff', pitchable: false, polygons: [circle(0, 0, 0.5)], reynoldsLength: 1, forceLength: 1, forceLengthLabel: 'diameter', description: kind === 'sphere' ? 'Circular section through the sphere centre (2D, so it behaves as a cylinder)' : 'Circular cylinder in cross-flow' }
    case 'cube':
      return { ...base, family: 'bluff', polygons: [rect(-0.5, -0.5, 0.5, 0.5)], reynoldsLength: 1, forceLength: 1, forceLengthLabel: 'frontal height', description: 'Square cross-section (2D square cylinder)' }
    case 'wedge':
      return { ...base, family: 'bluff', polygons: [[[-0.75, 0], [0.7, -0.5], [0.7, 0.5]]], reynoldsLength: 1.45, forceLength: 1, forceLengthLabel: 'base height', description: 'Triangular wedge, apex facing the wind' }
    case 'suv':
    case 'coupe':
    case 'sports':
    case 'spoiler':
    case 'wing':
    case 'race': {
      const bodyKey = kind === 'suv' || kind === 'coupe' ? kind : 'sports'
      const polygons: Vec2[][] = [carBodies[bodyKey]]
      const wheelR = kind === 'suv' ? 0.075 : 0.064
      // Wheels sit just above the moving belt. They are drawn for reference only (see visualOnly below).
      const hub = wheelR + 0.022
      polygons.push(circle(0.18, hub, wheelR, 36), circle(0.8, hub, wheelR, 36))
      if (kind === 'spoiler') {
        // Lip spoiler hinged at the boot edge; angle tilts it up into the flow.
        const lip: Vec2[] = [[0, 0], [0.1, 0], [0.1, 0.012], [0, 0.012]]
        polygons.push(transform(lip, 1, o.rearWingDeg * Math.PI / 180, [0, 0], [0.905, 0.205]))
      }
      if (kind === 'wing') polygons.push(rect(0.9, 0.2, 0.915, 0.33), rearWing(0.17, 0.86, 0.335, o.rearWingDeg))
      if (kind === 'race') polygons.push(rect(-0.035, 0.042, 0.12, 0.052), rect(0.92, 0.19, 0.935, 0.35), rearWing(0.2, 0.85, 0.355, o.rearWingDeg))
      const height = Math.max(...polygons.flat().map(p => p[1]))
      // The wheels (polygons 1 and 2) are drawn but not solid: the centreline slice passes
      // between them, so air (and smoke) flows under the floor as it does under a real car.
      return { family: 'vehicle', onGround: true, pitchable: false, polygons, visualOnly: [1, 2], reynoldsLength: 1, forceLength: height, forceLengthLabel: 'frontal height', description: 'Side profile on a moving ground belt (2D slice through the centreline, between the wheels, so air flows under the floor)' }
    }
  }
}

/** Tunnel size in base units B. Tall enough that default-scale models block under 5%. */
export const tunnelSize = (onGround: boolean) => ({ height: onGround ? 2.6 : 3.2 })

/** Projected frontal height of a body (body units) at a given angle of attack. */
function frontalHeight(body: CfdBody, angleOfAttackDeg: number): number {
  const angle = body.pitchable ? -angleOfAttackDeg * Math.PI / 180 : 0
  let top = -Infinity; let bottom = Infinity
  for (const p of body.polygons.flatMap(poly => transform(poly, 1, angle, [0, 0], [0, 0]))) { top = Math.max(top, p[1]); bottom = Math.min(bottom, p[1]) }
  return body.onGround ? top : top - bottom
}

/** Largest model scale that keeps blockage at or below `target` (default 4.5%) at the given incidence. */
export function defaultScaleFor(kind: ModelKind, options: Partial<BodyOptions> = {}, angleOfAttackDeg = 4, target = 0.045): number {
  const body = cfdBodyFor(kind, { ...options, scale: 1 })
  const height = frontalHeight(body, angleOfAttackDeg)
  const raw = target * tunnelSize(body.onGround).height / height
  return Math.min(1, Math.floor(raw * 100) / 100)
}

export interface Tunnel {
  /** Cells per body unit B. */
  base: number
  nx: number
  ny: number
  /** Distance from inlet to the body reference point, in B. */
  offsetX: number
  /** Absolute scale at which the plain body blocks ~4.5% of the tunnel (model scale 1×). */
  defaultScale: number
}

/**
 * Sizes the tunnel around the default-scale body. Lifting sections get a fixed
 * number of cells per unit chord; bluff bodies and cars get a fixed number of
 * cells across their frontal height, so they stay resolved even though they fill
 * under 5% of the tunnel. The grid depends only on the model kind and resolution,
 * so scale, angle, slats and flaps can change without restarting the flow.
 */
export function tunnelFor(kind: ModelKind, airfoil: AirfoilCode, cellsPerUnit: number, frontalCells: number): Tunnel {
  const plain = cfdBodyFor(kind, { airfoil, scale: 1 })
  const defaultScale = defaultScaleFor(kind, { airfoil }, 4)
  const size = tunnelSize(plain.onGround)
  const lifting = plain.family === 'airfoil' || plain.family === 'plate'
  const base = lifting ? cellsPerUnit : frontalCells / (defaultScale * frontalHeight(plain, 0))
  const xs = plain.polygons.flat().map(p => p[0])
  const length = (Math.max(...xs) - Math.min(...xs)) * defaultScale
  const [kUp, kWake] = plain.family === 'bluff' ? [5, 15] : plain.family === 'vehicle' ? [2.5, 6] : [1.6, 3.2]
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const offsetX = clamp(kUp * length, 0.35, 1.4)
  const wake = clamp(kWake * length, 1.2, 3.8)
  return { base, nx: Math.round((offsetX + length + wake) * base), ny: Math.round(size.height * base), offsetX, defaultScale }
}

export interface CfdLayout {
  nx: number
  ny: number
  /** Base length B in cells. */
  base: number
  /** Lattice-space polygons (cells, y up, origin at bottom-left corner of the domain). */
  polygons: Vec2[][]
  mask: Uint8Array
  /** Wall distance per boundary link for interpolated bounce-back. */
  linkFractions: Float32Array
  blockage: number
  /** Leading and trailing edge in lattice space, for lifting sections. */
  chord: { le: Vec2; te: Vec2 } | null
  /** Lattice-space bounding box of the body. */
  bounds: { x0: number; x1: number; y0: number; y1: number }
  roles: ElementRole[]
}

/** Places a body in the tunnel and rasterises it. */
/** Fewest cells of air kept between a car's floor and the road. */
const MIN_FLOOR_GAP = 3

export function layoutBody(body: CfdBody, tunnel: Tunnel, angleOfAttackDeg: number): CfdLayout {
  const { base, nx, ny } = tunnel
  const angle = body.pitchable ? -angleOfAttackDeg * Math.PI / 180 : 0
  let offset: Vec2 = body.onGround ? [tunnel.offsetX * base, 0] : [tunnel.offsetX * base, ny / 2]
  let polygons = body.polygons.map(poly => transform(poly, base, angle, [0, 0], offset))
  if (body.onGround) {
    // Keep at least 1.2 cells under the wheels so small models never touch the moving belt.
    const lowest = Math.min(...polygons.flat().map(p => p[1]))
    if (lowest < 1.2) { offset = [offset[0], offset[1] + 1.2 - lowest]; polygons = body.polygons.map(poly => transform(poly, base, angle, [0, 0], offset)) }
  }
  if (body.onGround) {
    // Air must be able to flow under the floor: a gap of 1–2 cells chokes it, the air piles
    // up underneath and pushes the car up with a large spurious force. Raise the solid body
    // (not the drawn-only wheels, which keep touching the road) to leave MIN_FLOOR_GAP cells.
    const solidIdx = polygons.map((_, i) => i).filter(i => !body.visualOnly?.includes(i))
    const floor = Math.min(...solidIdx.flatMap(i => polygons[i]!.map(p => p[1])))
    if (floor < MIN_FLOOR_GAP) {
      const lift = MIN_FLOOR_GAP - floor
      polygons = polygons.map((poly, i) => solidIdx.includes(i) ? poly.map(([x, y]) => [x, y + lift] as Vec2) : poly)
    }
  }
  const solid = body.visualOnly?.length ? polygons.filter((_, i) => !body.visualOnly!.includes(i)) : polygons
  const mask = rasterize(solid, nx, ny)
  const linkFractions = computeLinkFractions(solid, mask, nx, ny)
  const chord = body.chord ? { le: transform([body.chord.le], base, angle, [0, 0], offset)[0]!, te: transform([body.chord.te], base, angle, [0, 0], offset)[0]! } : null
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
  for (const p of polygons.flat()) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  // A car blocks the tunnel from its floor to its roof: the gap under the floor is open.
  const solidFloor = body.onGround ? Math.min(...solid.flat().map(p => p[1])) : y0
  const blockage = Math.max(0, (y1 - solidFloor) / ny)
  return { nx, ny, base, polygons, mask, linkFractions, chord, blockage, bounds: { x0, x1, y0, y1 }, roles: polygons.map((_, i) => body.roles?.[i] ?? 'main') }
}

/** Marks cells whose centres lie inside any polygon (even-odd rule per polygon, union across polygons). */
export function rasterize(polygons: Vec2[][], nx: number, ny: number): Uint8Array {
  const mask = new Uint8Array(nx * ny)
  for (const poly of polygons) {
    let minY = Infinity
    let maxY = -Infinity
    for (const p of poly) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]) }
    const y0 = Math.max(0, Math.floor(minY - 0.5))
    const y1 = Math.min(ny - 1, Math.ceil(maxY))
    const xs: number[] = []
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5
      xs.length = 0
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!
        const b = poly[j]!
        if ((a[1] > cy) !== (b[1] > cy)) xs.push(a[0] + (cy - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
      }
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const start = Math.max(0, Math.ceil(xs[k]! - 0.5))
        const end = Math.min(nx - 1, Math.floor(xs[k + 1]! - 0.5))
        for (let x = start; x <= end; x++) mask[y * nx + x] = 1
      }
    }
    // Thin features (struts, plates, trailing edges thinner than ~2 cells) could
    // fall between cell centres; trace their outline so they stay solid.
    let minX = Infinity
    let maxX = -Infinity
    for (const p of poly) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]) }
    if (Math.min(maxX - minX, maxY - minY) < 2.5) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!
        const b = poly[j]!
        const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2) + 1
        for (let k = 0; k <= steps; k++) {
          const x = Math.floor(a[0] + (b[0] - a[0]) * k / steps)
          const y = Math.floor(a[1] + (b[1] - a[1]) * k / steps)
          if (x >= 0 && y >= 0 && x < nx && y < ny) mask[y * nx + x] = 1
        }
      }
    }
  }
  closeDiagonalLeaks(mask, nx, ny)
  return mask
}

/**
 * A thin, tilted body (a 1–2 cell thick rear wing, a flap's trailing edge) fills as a
 * diagonal staircase whose solid cells touch only at corners. The lattice's diagonal
 * links pass straight through such a corner, so air leaks through the "solid" wall and
 * produces large spurious forces. Close every corner-only contact by filling one of the
 * two open cells of the 2×2 block (the one with more solid neighbours).
 */
function closeDiagonalLeaks(mask: Uint8Array, nx: number, ny: number) {
  const solidAround = (x: number, y: number) => {
    let n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx; const yy = y + dy
      if ((dx || dy) && xx >= 0 && yy >= 0 && xx < nx && yy < ny) n += mask[yy * nx + xx]!
    }
    return n
  }
  for (let pass = 0; pass < 2; pass++) {
    let changed = false
    for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
      const a = y * nx + x; const b = a + 1; const c = a + nx; const d = c + 1
      // Solid on one diagonal of the 2×2 block, open on the other.
      const leak = (mask[a] && mask[d] && !mask[b] && !mask[c]) ? [b, c] : (mask[b] && mask[c] && !mask[a] && !mask[d]) ? [a, d] : null
      if (!leak) continue
      const [p, q] = leak as [number, number]
      const fill = solidAround(p % nx, Math.floor(p / nx)) >= solidAround(q % nx, Math.floor(q / nx)) ? p : q
      mask[fill] = 1
      changed = true
    }
    if (!changed) break
  }
}

const EXK = [0, 1, 0, -1, 0, 1, -1, -1, 1]
const EYK = [0, 0, 1, 0, -1, 1, 1, -1, -1]

/**
 * For every fluid cell whose neighbour at x − e_k is solid, the fraction q ∈ (0, 1]
 * of the link from the cell centre towards that neighbour that lies in fluid.
 * Links that miss every polygon edge (thin traced features) keep q = 0.5.
 */
export function computeLinkFractions(polygons: Vec2[][], mask: Uint8Array, nx: number, ny: number): Float32Array {
  const n = nx * ny
  const q = new Float32Array(9 * n).fill(0.5)
  const boxes = polygons.map(poly => {
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
    for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    return { x0: x0 - 2, x1: x1 + 2, y0: y0 - 2, y1: y1 + 2 }
  })
  // Boundary links only exist next to the body, so scan just its bounding box.
  const gx0 = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.x0))))
  const gx1 = Math.min(nx - 1, Math.ceil(Math.max(...boxes.map(b => b.x1))))
  const gy0 = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.y0))))
  const gy1 = Math.min(ny - 1, Math.ceil(Math.max(...boxes.map(b => b.y1))))
  for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) {
    const i = y * nx + x
    if (mask[i]) continue
    for (let k = 1; k < 9; k++) {
      const xs = x - EXK[k]!; const ys = y - EYK[k]!
      if (xs < 0 || ys < 0 || xs >= nx || ys >= ny || !mask[ys * nx + xs]) continue
      const px = x + 0.5; const py = y + 0.5
      const dx = -EXK[k]!; const dy = -EYK[k]!
      let best = Infinity
      for (let p = 0; p < polygons.length; p++) {
        const box = boxes[p]!
        if (px < box.x0 || px > box.x1 || py < box.y0 || py > box.y1) continue
        const poly = polygons[p]!
        for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
          const ax = poly[a]![0]; const ay = poly[a]![1]
          const ex = poly[b]![0] - ax; const ey = poly[b]![1] - ay
          const den = dx * ey - dy * ex
          if (Math.abs(den) < 1e-12) continue
          const wx = ax - px; const wy = ay - py
          const t = (wx * ey - wy * ex) / den
          const s = (wx * dy - wy * dx) / den
          if (t > 0 && t <= 1.0001 && s >= 0 && s <= 1 && t < best) best = t
        }
      }
      if (best <= 1.0001) q[k * n + i] = Math.min(1, Math.max(0.02, best))
    }
  }
  return q
}
