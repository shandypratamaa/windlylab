import type { Vec2 } from '../../physics/lbm/geometry.ts'

/**
 * Inviscid, incompressible flow around a multi-element aerofoil (slat, main wing,
 * flaps) by the constant-strength vortex panel method (Katz & Plotkin, "Low-Speed
 * Aerodynamics", §11.2): every element's outline is split into straight panels carrying
 * a uniform vortex sheet; the sheet strengths make the flow tangent to every panel, and
 * a Kutta condition at each element's trailing edge makes the flow leave it smoothly.
 * This is the classic way high-lift systems are analysed: it captures the slot flow,
 * the circulation the flaps add and how each element changes the others. It does not
 * model viscosity (no boundary layers, separation or wake).
 *
 * Units: chord = 1, free stream = (1, 0). Vortex strengths are counter-clockwise positive.
 */
export interface PanelFlow {
  count: number
  /** Per panel: start x, y, unit tangent x, y, length, midpoint x, y, vortex strength. */
  ax: Float64Array; ay: Float64Array; tx: Float64Array; ty: Float64Array
  len: Float64Array; mx: Float64Array; my: Float64Array; gamma: Float64Array
  /** Section lift coefficient from the total circulation (Kutta–Joukowski). */
  cl: number
}

const TWO_PI = 2 * Math.PI

/** Re-order a closed outline clockwise, starting at its trailing edge (rearmost point). */
function fromTrailingEdge(poly: Vec2[]): Vec2[] {
  let area = 0
  for (let i = 0; i < poly.length; i++) { const [x0, y0] = poly[i]!; const [x1, y1] = poly[(i + 1) % poly.length]!; area += x0 * y1 - x1 * y0 }
  const cw = area > 0 ? [...poly].reverse() : [...poly]
  let te = 0
  for (let i = 1; i < cw.length; i++) if (cw[i]![0] > cw[te]![0]) te = i
  return [...cw.slice(te), ...cw.slice(0, te)]
}

/**
 * Resample a closed outline (starting at the trailing edge) into n panels, spaced more
 * closely near the trailing edge and the leading edge (half-cosine in each half).
 */
function resample(poly: Vec2[], n: number): Vec2[] {
  const pts = [...poly, poly[0]!]
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]))
  const total = cum[cum.length - 1]!
  // The leading edge is the point farthest from the trailing edge.
  let le = 0; let far = -1
  for (let i = 0; i < poly.length; i++) { const d = Math.hypot(poly[i]![0] - poly[0]![0], poly[i]![1] - poly[0]![1]); if (d > far) { far = d; le = i } }
  const sLe = cum[le]!
  const at = (s: number): Vec2 => {
    let k = 1
    while (k < cum.length - 1 && cum[k]! < s) k++
    const f = (s - cum[k - 1]!) / Math.max(1e-12, cum[k]! - cum[k - 1]!)
    return [pts[k - 1]![0] + f * (pts[k]![0] - pts[k - 1]![0]), pts[k - 1]![1] + f * (pts[k]![1] - pts[k - 1]![1])]
  }
  const half = Math.max(2, Math.round(n * sLe / total))
  const out: Vec2[] = []
  for (let k = 0; k < half; k++) out.push(at(sLe * (1 - Math.cos(Math.PI * k / half)) / 2))
  const rest = n - half
  for (let k = 0; k < rest; k++) out.push(at(sLe + (total - sLe) * (1 - Math.cos(Math.PI * k / rest)) / 2))
  return out
}

/** Velocity at (px, py) induced by panel j carrying unit vortex strength. */
function unitPanelVelocity(f: Omit<PanelFlow, 'cl'>, j: number, px: number, py: number, out: Float64Array) {
  const tx = f.tx[j]!; const ty = f.ty[j]!; const L = f.len[j]!
  const dx = px - f.ax[j]!; const dy = py - f.ay[j]!
  const x = dx * tx + dy * ty; const y = -dx * ty + dy * tx
  const ul = -(Math.atan2(y, x - L) - Math.atan2(y, x)) / TWO_PI
  const vl = Math.log((x * x + y * y) / ((x - L) * (x - L) + y * y)) / (2 * TWO_PI)
  out[0] = ul * tx - vl * ty; out[1] = ul * ty + vl * tx
}

/**
 * Solve the flow around these element outlines (wing coordinates, already pitched to
 * the angle of attack) in a free stream of (1, 0).
 */
export function solvePanelFlow(polygons: Vec2[][], panelsPerElement: (index: number, perimeter: number) => number): PanelFlow {
  const elements = polygons.map((poly, e) => {
    const ordered = fromTrailingEdge(poly)
    let perimeter = 0
    for (let i = 0; i < ordered.length; i++) { const a = ordered[i]!; const b = ordered[(i + 1) % ordered.length]!; perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]) }
    return resample(ordered, panelsPerElement(e, perimeter))
  })
  const count = elements.reduce((t, el) => t + el.length, 0)
  const f = { count, ax: new Float64Array(count), ay: new Float64Array(count), tx: new Float64Array(count), ty: new Float64Array(count), len: new Float64Array(count), mx: new Float64Array(count), my: new Float64Array(count), gamma: new Float64Array(count) }
  const ranges: [number, number][] = []
  let k = 0
  for (const el of elements) {
    const start = k
    for (let i = 0; i < el.length; i++, k++) {
      const a = el[i]!; const b = el[(i + 1) % el.length]!
      const L = Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1]))
      f.ax[k] = a[0]; f.ay[k] = a[1]; f.len[k] = L
      f.tx[k] = (b[0] - a[0]) / L; f.ty[k] = (b[1] - a[1]) / L
      f.mx[k] = (a[0] + b[0]) / 2; f.my[k] = (a[1] + b[1]) / 2
    }
    ranges.push([start, k])
  }
  // Flow tangency at every panel midpoint; on each element one equation (half-way round)
  // is replaced by the Kutta condition γ(first) + γ(last) = 0 at the trailing edge.
  const A = new Float64Array(count * count)
  const rhs = new Float64Array(count)
  const v = new Float64Array(2)
  for (let i = 0; i < count; i++) {
    const nx = -f.ty[i]!; const ny = f.tx[i]!
    for (let j = 0; j < count; j++) {
      unitPanelVelocity(f, j, f.mx[i]!, f.my[i]!, v)
      A[i * count + j] = v[0]! * nx + v[1]! * ny
    }
    rhs[i] = -nx
  }
  for (const [start, end] of ranges) {
    const row = start + Math.floor((end - start) / 2)
    A.fill(0, row * count, (row + 1) * count)
    A[row * count + start] = 1; A[row * count + end - 1] = 1
    rhs[row] = 0
  }
  solveInPlace(A, rhs, count)
  f.gamma.set(rhs)
  let circulation = 0
  for (let j = 0; j < count; j++) circulation += f.gamma[j]! * f.len[j]!
  return { ...f, cl: -2 * circulation }
}

/** Gaussian elimination with partial pivoting; the solution replaces b. */
function solveInPlace(A: Float64Array, b: Float64Array, n: number) {
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]!) > Math.abs(A[p * n + c]!)) p = r
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]!; A[c * n + k] = A[p * n + k]!; A[p * n + k] = t }
      const t = b[c]!; b[c] = b[p]!; b[p] = t
    }
    const d = A[c * n + c]!
    for (let r = c + 1; r < n; r++) {
      const m = A[r * n + c]! / d
      if (m === 0) continue
      for (let k = c; k < n; k++) A[r * n + k] = A[r * n + k]! - m * A[c * n + k]!
      b[r] = b[r]! - m * b[c]!
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!
    for (let k = r + 1; k < n; k++) s -= A[r * n + k]! * b[k]!
    b[r] = s / A[r * n + r]!
  }
}

/**
 * Flow velocity at (px, py). Panels more than three panel-lengths away are treated as
 * point vortices (the far field of a panel), nearer ones with the exact panel formula.
 */
const near = new Float64Array(2)
export function flowVelocity(f: PanelFlow, px: number, py: number, out: Float64Array) {
  let u = 1; let w = 0
  for (let j = 0; j < f.count; j++) {
    const g = f.gamma[j]!
    const dx = px - f.mx[j]!; const dy = py - f.my[j]!
    const r2 = dx * dx + dy * dy
    const L = f.len[j]!
    if (r2 > 9 * L * L) {
      const k = g * L / (TWO_PI * r2)
      u -= k * dy; w += k * dx
    } else {
      unitPanelVelocity(f, j, px, py, near)
      u += g * near[0]!; w += g * near[1]!
    }
  }
  out[0] = u; out[1] = w
}
