/**
 * D2Q9 lattice Boltzmann solver for 2D incompressible flow.
 *
 * - BGK collision with a Smagorinsky large-eddy subgrid model (Hou et al. 1996),
 *   so moderately high Reynolds numbers stay stable on coarse browser grids.
 * - Fused pull-streaming over two population buffers.
 * - Interpolated bounce-back (Bouzidi, Firdaouss & Lallemand 2001) using the
 *   exact wall distance on each boundary link, so curved surfaces are not
 *   treated as staircases. Forces on the body come from the
 *   momentum-exchange method (Ladd 1994), giving drag and lift directly from
 *   the solved populations instead of from an assumed coefficient.
 * - Velocity inlet (equilibrium populations), zero-gradient outlet with a
 *   viscous sponge layer, and free-slip / no-slip / moving-wall boundaries
 *   on the top and bottom of the tunnel.
 *
 * - Optional multi-threading: the grid is split into bands of rows that helper
 *   workers advance in lockstep over shared memory (SharedArrayBuffer + Atomics).
 *   Every cell runs exactly the same arithmetic as in the single-threaded path.
 *
 * Everything is expressed in lattice units (dx = dt = 1, reference density 1).
 */

export type WallType = 'free-slip' | 'no-slip' | 'moving'

export interface LbmOptions {
  nx: number
  ny: number
  /** Inlet velocity in lattice units. Keep ≲ 0.12 for low lattice Mach number. */
  inletVelocity: number
  /** Kinematic viscosity in lattice units. */
  viscosity: number
  /** Smagorinsky constant. 0 disables the subgrid model. */
  smagorinsky?: number
  inletProfile?: 'uniform' | 'parabolic'
  bottom?: WallType
  top?: WallType
  /** Width of the outlet sponge layer in cells. */
  spongeCells?: number
  /** Number of steps over which the inlet velocity ramps up from zero. */
  rampSteps?: number
  /**
   * Widths (cells) of absorbing far-field layers that relax populations towards
   * the free-stream equilibrium. They soak up pressure waves that would otherwise
   * reflect between boundaries and contaminate the force history.
   */
  absorbing?: { top: number; bottom: number; inlet: number; outlet: number }
  /** For this many steps after a reset, a weak transverse inlet wobble breaks symmetry so natural vortex shedding can develop. */
  perturbSteps?: number
}

/** Anything that can receive a message and be stopped: a browser Worker or a Node worker_threads Worker. */
export interface ThreadLike { postMessage(message: unknown): void; terminate(): unknown }

/** All per-cell state, allocated on SharedArrayBuffers when the solver is multi-threaded. */
export interface SolverBuffers {
  a: Float32Array; b: Float32Array
  rho: Float32Array; ux: Float32Array; uy: Float32Array
  solid: Uint8Array; edge: Uint8Array
  linkQ: Float32Array; relief: Float32Array
  /** [generation, done count, ready count, quit flag, relief box x0, x1, y0, y1]. */
  ctrl: Int32Array
  /** [step, viscosity, then fx, fy, rhoSum per band]. */
  shared: Float64Array
}

/** Message that starts a helper thread on one band of rows. */
export interface HelperInit { options: LbmOptions; buffers: SolverBuffers; band: number; y0: number; y1: number }

const MAX_BANDS = 16

export const EX = Int8Array.from([0, 1, 0, -1, 0, 1, -1, -1, 1])
export const EY = Int8Array.from([0, 0, 1, 0, -1, 1, 1, -1, -1])

export const W = Float64Array.from([4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36])
const OPP = Int8Array.from([0, 3, 4, 1, 2, 7, 8, 5, 6])
/** Direction with the y component mirrored, used for specular (free-slip) walls. */
const REFY = Int8Array.from([0, 1, 4, 3, 2, 8, 7, 6, 5])

export class LbmSolver {
  readonly nx: number
  readonly ny: number
  readonly n: number
  readonly rho: Float32Array
  readonly ux: Float32Array
  readonly uy: Float32Array
  readonly solid: Uint8Array
  /** Force on all solid cells from the most recent step (lattice units). */
  forceX = 0
  forceY = 0
  step = 0
  diverged = false
  /** Population buffers; which one holds the current state follows the step parity. */
  private readonly a: Float32Array
  private readonly b: Float32Array
  private readonly fk = new Float64Array(9)
  private readonly fe = new Float64Array(9)
  private readonly spongeTau: Float32Array
  /** Cells in the far-field absorbing layers (ascending) and their relaxation rates. */
  private absorbIndex = new Int32Array(0)
  private absorbSigma = new Float32Array(0)
  /** Per-cell side-relief rate (0 where relief is off). */
  private readonly relief: Float32Array
  private reliefCells: Int32Array = new Int32Array(0)
  private readonly target = new Float64Array(9)
  private readonly partial = new Float64Array(3)
  /** 1 where a cell touches the domain edge or a solid cell and needs the general boundary path. */
  private readonly edge: Uint8Array
  /** Fraction q of each boundary link (fluid node → wall) that lies in the fluid; 0.5 = halfway bounce-back. */
  private readonly linkQ: Float32Array
  private readonly ctrl: Int32Array
  private readonly shared: Float64Array
  private threads: ThreadLike[] = []
  private bands: [number, number][] = []
  private opts: Required<LbmOptions>

  /**
   * @param threads   Optional helper threads: `spawn` starts one helper (which must call
   *                  `runHelper` with the message it receives), `count` is how many.
   * @param view      Internal: build a helper's view onto an existing solver's shared buffers.
   */
  constructor(options: LbmOptions, threads?: { count: number; spawn: () => ThreadLike }, view?: SolverBuffers) {
    this.opts = { smagorinsky: 0.16, inletProfile: 'uniform', bottom: 'free-slip', top: 'free-slip', spongeCells: Math.round(options.nx * 0.08), rampSteps: 400, absorbing: { top: 0, bottom: 0, inlet: 0, outlet: 0 }, perturbSteps: 0, ...options }
    this.nx = options.nx
    this.ny = options.ny
    this.n = this.nx * this.ny
    const n = this.n
    const parallel = !view && threads && threads.count > 0 && typeof SharedArrayBuffer !== 'undefined'
    const buf = (bytes: number) => parallel ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
    const v = view ?? {
      a: new Float32Array(buf(36 * n)), b: new Float32Array(buf(36 * n)),
      rho: new Float32Array(buf(4 * n)), ux: new Float32Array(buf(4 * n)), uy: new Float32Array(buf(4 * n)),
      solid: new Uint8Array(buf(n)), edge: new Uint8Array(buf(n)),
      linkQ: new Float32Array(buf(36 * n)).fill(0.5), relief: new Float32Array(buf(4 * n)),
      ctrl: new Int32Array(buf(32)), shared: new Float64Array(buf(8 * (2 + 3 * MAX_BANDS))),
    }
    this.a = v.a; this.b = v.b; this.rho = v.rho; this.ux = v.ux; this.uy = v.uy
    this.solid = v.solid; this.edge = v.edge; this.linkQ = v.linkQ; this.relief = v.relief
    this.ctrl = v.ctrl; this.shared = v.shared
    this.spongeTau = new Float32Array(this.nx)
    this.updateSponge()
    this.updateAbsorbing()
    if (view) return
    this.ctrl[4] = 0; this.ctrl[5] = -1; this.ctrl[6] = 0; this.ctrl[7] = -1
    this.updateEdges()
    this.reset()
    if (parallel) this.startThreads(threads!.count, threads!.spawn)
  }

  /** Shared state, for building helper views. */
  get buffers(): SolverBuffers {
    return { a: this.a, b: this.b, rho: this.rho, ux: this.ux, uy: this.uy, solid: this.solid, edge: this.edge, linkQ: this.linkQ, relief: this.relief, ctrl: this.ctrl, shared: this.shared }
  }

  /** Number of helper threads that have started and joined the lockstep. */
  get activeThreads(): number { return this.threads.length && Atomics.load(this.ctrl, 2) === this.threads.length ? this.threads.length : 0 }

  private startThreads(count: number, spawn: () => ThreadLike) {
    const k = Math.min(count, MAX_BANDS - 1, Math.floor(this.ny / 8) - 1)
    if (k < 1) return
    // Equal bands of rows; this thread keeps band 0.
    const rows = this.ny / (k + 1)
    this.bands = Array.from({ length: k + 1 }, (_, i) => [Math.round(i * rows), Math.round((i + 1) * rows) - 1] as [number, number])
    const options: LbmOptions = { ...this.opts }
    for (let i = 1; i <= k; i++) {
      const thread = spawn()
      const [y0, y1] = this.bands[i]!
      thread.postMessage({ options, buffers: this.buffers, band: i, y0, y1 } satisfies HelperInit)
      this.threads.push(thread)
    }
  }

  /** Stop the helper threads. The solver keeps working single-threaded. */
  dispose() {
    if (!this.threads.length) return
    Atomics.store(this.ctrl, 3, 1)
    Atomics.add(this.ctrl, 0, 1)
    Atomics.notify(this.ctrl, 0)
    for (const t of this.threads) t.terminate()
    this.threads = []
  }

  private updateAbsorbing() {
    const { nx, ny } = this
    const { top, bottom, inlet, outlet } = this.opts.absorbing
    const index: number[] = []
    const sigma: number[] = []
    const ramp = (distance: number, width: number) => width > 0 && distance < width ? (1 - distance / width) ** 2 : 0
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const s = Math.max(ramp(ny - 1 - y, top), ramp(y, bottom), ramp(x, inlet) * 0.5, ramp(nx - 1 - x, outlet))
      if (s > 0) { index.push(y * nx + x); sigma.push(0.08 * s) }
    }
    this.absorbIndex = Int32Array.from(index)
    this.absorbSigma = Float32Array.from(sigma)
  }

  /**
   * Side relief ("2.5D"): in the listed cells local pressure relaxes towards
   * ambient at rate sigma per step (a mass source/sink), standing in for air that
   * would flow around the sides of a 3D body and equalise its pressure field.
   */
  setRelief(index: Int32Array, sigma: Float32Array) {
    const { nx, ctrl } = this
    for (let j = 0; j < this.reliefCells.length; j++) this.relief[this.reliefCells[j]!] = 0
    let x0 = nx; let x1 = -1; let y0 = this.ny; let y1 = -1
    for (let j = 0; j < index.length; j++) {
      const i = index[j]!
      this.relief[i] = sigma[j]!
      const x = i % nx; const y = (i - x) / nx
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    // Bounding box of the relief region: [x0, x1, y0, y1] (empty when x1 < x0).
    ctrl[4] = x0; ctrl[5] = x1; ctrl[6] = y0; ctrl[7] = y1
    this.reliefCells = index
  }

  /** Smooth 0→1 start-up factor. */
  private rampFactor(step = this.step): number {
    const steps = this.opts.rampSteps
    if (steps <= 0) return 1
    const t = Math.min(1, step / steps)
    return t * t * (3 - 2 * t)
  }

  /** Transverse inlet velocity used briefly after a reset to break symmetry. */
  private inletTransverse(step: number): number {
    const { perturbSteps, inletVelocity } = this.opts
    if (step >= perturbSteps) return 0
    const fade = 1 - step / perturbSteps
    return 0.15 * inletVelocity * fade * Math.sin(2 * Math.PI * step / 350)
  }

  get options(): Readonly<Required<LbmOptions>> { return this.opts }
  get tau(): number { return 3 * this.opts.viscosity + 0.5 }
  /** Current populations (the buffer the next step streams from). */
  private get f(): Float32Array { return this.step & 1 ? this.b : this.a }

  setViscosity(viscosity: number) { this.opts.viscosity = viscosity; this.updateSponge() }
  setInletVelocity(velocity: number) { this.opts.inletVelocity = velocity }
  setWalls(bottom: WallType, top: WallType) { this.opts.bottom = bottom; this.opts.top = top }

  /**
   * Replace the solid mask. Cells that change state are reinitialised.
   * `linkFractions` (9·n, indexed k·n + i) gives the wall distance q for links whose
   * upstream neighbour (x − e_k) is solid; omit it for plain halfway bounce-back.
   */
  setSolid(mask: Uint8Array, linkFractions?: Float32Array) {
    const { n, nx, f } = this
    if (linkFractions) this.linkQ.set(linkFractions)
    else this.linkQ.fill(0.5)
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
    for (let i = 0; i < n; i++) {
      const next = mask[i] ? 1 : 0
      if (next === this.solid[i]) continue
      this.solid[i] = next
      const x = i % nx; const y = (i - x) / nx
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      if (next) { this.rho[i] = 1; this.ux[i] = 0; this.uy[i] = 0; for (let k = 0; k < 9; k++) f[k * n + i] = W[k]! }
      else {
        // A cell uncovered by a moving body starts at its fluid neighbours' average state,
        // so the body slides through the flow instead of leaving pressure pulses behind.
        let r = 0; let u = 0; let w = 0; let c = 0
        for (let k = 1; k < 9; k++) {
          const xn = x + EX[k]!; const yn = y + EY[k]!
          if (xn < 0 || yn < 0 || xn >= nx || yn >= this.ny) continue
          const j = yn * nx + xn
          if (mask[j]) continue
          r += this.rho[j]!; u += this.ux[j]!; w += this.uy[j]!; c++
        }
        if (c) { r /= c; u /= c; w /= c } else { r = 1 }
        this.rho[i] = r; this.ux[i] = u; this.uy[i] = w
        for (let k = 0; k < 9; k++) f[k * n + i] = equilibrium(k, r, u, w)
      }
    }
    if (x0 <= x1) this.updateEdges(x0 - 1, x1 + 1, y0 - 1, y1 + 1)
  }

  private updateEdges(x0 = 0, x1 = this.nx - 1, y0 = 0, y1 = this.ny - 1) {
    const { nx, ny, solid, edge } = this
    for (let y = Math.max(0, y0); y <= Math.min(ny - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(nx - 1, x1); x++) {
      const i = y * nx + x
      if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) { edge[i] = 1; continue }
      edge[i] = solid[i - 1] || solid[i + 1] || solid[i - nx] || solid[i + nx] || solid[i - nx - 1] || solid[i - nx + 1] || solid[i + nx - 1] || solid[i + nx + 1] ? 1 : 0
    }
  }

  /** Inlet x-velocity at row y including the start-up ramp. */
  inletVelocityAt(y: number, step = this.step): number {
    const { inletVelocity, inletProfile } = this.opts
    const ramped = inletVelocity * this.rampFactor(step)
    if (inletProfile === 'parabolic') {
      const h = this.ny
      const yc = y + 0.5
      return 4 * ramped * yc * (h - yc) / (h * h)
    }
    return ramped
  }

  reset() {
    const { n, nx, a } = this
    this.step = 0; this.diverged = false; this.forceX = 0; this.forceY = 0
    for (let i = 0; i < n; i++) {
      const u = this.solid[i] ? 0 : this.opts.rampSteps > 0 ? 0 : this.inletVelocityAt(Math.floor(i / nx))
      this.rho[i] = 1; this.ux[i] = u; this.uy[i] = 0
      for (let k = 0; k < 9; k++) a[k * n + i] = equilibrium(k, 1, u, 0)
    }
    this.b.set(a)
  }

  /** Advance the simulation. Returns false if the solution diverged. */
  run(steps: number): boolean {
    for (let s = 0; s < steps && !this.diverged; s++) this.stepOnce()
    return !this.diverged
  }

  private updateSponge() {
    const { nx } = this
    const width = Math.max(1, this.opts.spongeCells)
    for (let x = 0; x < nx; x++) {
      const t = (x - (nx - width)) / width
      // Raise relaxation time towards the outlet to damp reflected vortices.
      this.spongeTau[x] = t > 0 ? 0.6 * t * t : 0
    }
  }

  private stepOnce() {
    const threads = this.activeThreads
    let fx: number; let fy: number; let rhoSum: number
    if (threads) {
      const { ctrl, shared } = this
      shared[0] = this.step; shared[1] = this.opts.viscosity
      Atomics.store(ctrl, 1, 0)
      Atomics.add(ctrl, 0, 1)
      Atomics.notify(ctrl, 0)
      const [y0, y1] = this.bands[0]!
      this.stepRows(y0, y1, this.step, this.opts.viscosity, this.partial)
      fx = this.partial[0]!; fy = this.partial[1]!; rhoSum = this.partial[2]!
      let done: number
      while ((done = Atomics.load(ctrl, 1)) < threads) Atomics.wait(ctrl, 1, done, 100)
      for (let k = 1; k <= threads; k++) { fx += shared[2 + 3 * k]!; fy += shared[3 + 3 * k]!; rhoSum += shared[4 + 3 * k]! }
    } else {
      this.stepRows(0, this.ny - 1, this.step, this.opts.viscosity, this.partial)
      fx = this.partial[0]!; fy = this.partial[1]!; rhoSum = this.partial[2]!
    }
    this.forceX = fx
    this.forceY = fy
    this.step++
    if (!Number.isFinite(rhoSum) || !Number.isFinite(fx + fy)) this.diverged = true
  }

  /** Helper-thread loop: wait for each step signal, advance this band, report, repeat. */
  serveBand(band: number, y0: number, y1: number) {
    const { ctrl, shared } = this
    const out = new Float64Array(3)
    let gen = Atomics.load(ctrl, 0)
    Atomics.add(ctrl, 2, 1)
    for (;;) {
      Atomics.wait(ctrl, 0, gen)
      gen = Atomics.load(ctrl, 0)
      if (Atomics.load(ctrl, 3)) return
      this.stepRows(y0, y1, shared[0]!, shared[1]!, out)
      shared[2 + 3 * band] = out[0]!; shared[3 + 3 * band] = out[1]!; shared[4 + 3 * band] = out[2]!
      Atomics.add(ctrl, 1, 1)
      Atomics.notify(ctrl, 1)
    }
  }

  /** Stream, collide and apply far-field/relief sources for rows y0..y1 of step `step`. */
  private stepRows(y0: number, y1: number, step: number, viscosity: number, out: Float64Array) {
    const { nx, ny, n, solid, edge, rho, ux, uy, fk, fe, spongeTau, relief, linkQ, target } = this
    const f = step & 1 ? this.b : this.a
    const g = step & 1 ? this.a : this.b
    const { bottom, top, smagorinsky } = this.opts
    const tau0 = 3 * viscosity + 0.5
    const smag = 18 * Math.SQRT2 * smagorinsky * smagorinsky
    const wallU = this.opts.inletVelocity * this.rampFactor(step)
    const vIn = this.inletTransverse(step)
    for (let k = 0; k < 9; k++) target[k] = equilibrium(k, 1, wallU, 0)
    let fx = 0
    let fy = 0
    let rhoSum = 0
    for (let y = y0; y <= y1; y++) {
      const uIn = this.inletVelocityAt(y, step)
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x
        if (solid[i]) { ux[i] = 0; uy[i] = 0; rho[i] = 1; continue }
        if (!edge[i]) {
          // Interior fast path: unrolled pull-streaming and BGK-Smagorinsky collision.
          const f0 = f[i]!, f1 = f[n + i - 1]!, f2 = f[2 * n + i - nx]!, f3 = f[3 * n + i + 1]!, f4 = f[4 * n + i + nx]!
          const f5 = f[5 * n + i - 1 - nx]!, f6 = f[6 * n + i + 1 - nx]!, f7 = f[7 * n + i + 1 + nx]!, f8 = f[8 * n + i - 1 + nx]!
          const r = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8
          const u = (f1 - f3 + f5 - f6 - f7 + f8) / r
          const w = (f2 - f4 + f5 + f6 - f7 - f8) / r
          rho[i] = r; ux[i] = u; uy[i] = w
          rhoSum += r
          const usq = 1.5 * (u * u + w * w)
          const r9 = r / 9; const r36 = r / 36
          const a = 3 * u; const b = 3 * w; const c = 3 * (u + w); const d = 3 * (w - u)
          const e0 = 4 * r9 * (1 - usq)
          const e1 = r9 * (1 + a + 0.5 * a * a - usq), e3 = r9 * (1 - a + 0.5 * a * a - usq)
          const e2 = r9 * (1 + b + 0.5 * b * b - usq), e4 = r9 * (1 - b + 0.5 * b * b - usq)
          const e5 = r36 * (1 + c + 0.5 * c * c - usq), e7 = r36 * (1 - c + 0.5 * c * c - usq)
          const e6 = r36 * (1 + d + 0.5 * d * d - usq), e8 = r36 * (1 - d + 0.5 * d * d - usq)
          const n1 = f1 - e1, n2 = f2 - e2, n3 = f3 - e3, n4 = f4 - e4, n5 = f5 - e5, n6 = f6 - e6, n7 = f7 - e7, n8 = f8 - e8
          let tau = tau0 + spongeTau[x]!
          if (smag > 0) {
            const diag = n5 + n6 + n7 + n8
            const pxx = n1 + n3 + diag; const pyy = n2 + n4 + diag; const pxy = n5 - n6 + n7 - n8
            tau = 0.5 * (tau + Math.sqrt(tau * tau + smag * Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy) / r))
          }
          const keep = 1 - 1 / tau
          g[i] = e0 + keep * (f0 - e0)
          g[n + i] = e1 + keep * n1; g[2 * n + i] = e2 + keep * n2; g[3 * n + i] = e3 + keep * n3; g[4 * n + i] = e4 + keep * n4
          g[5 * n + i] = e5 + keep * n5; g[6 * n + i] = e6 + keep * n6; g[7 * n + i] = e7 + keep * n7; g[8 * n + i] = e8 + keep * n8
          continue
        }
        {
          let r = 0; let jx = 0; let jy = 0
          for (let k = 0; k < 9; k++) {
            const ex = EX[k]!; const ey = EY[k]!
            const xs = x - ex; const ys = y - ey
            let v: number
            if (xs < 0) {
              // Velocity inlet: equilibrium ghost node using the adjacent cell's density
              // so the prescribed volume flux is delivered regardless of back-pressure.
              v = equilibrium(k, rho[i]!, uIn, vIn)
            } else if (xs >= nx) {
              v = f[k * n + i]!
            } else if (ys < 0 || ys >= ny) {
              const wall = ys < 0 ? bottom : top
              if (wall === 'free-slip') v = f[REFY[k]! * n + y * nx + xs]!
              else if (wall === 'moving') v = f[OPP[k]! * n + i]! + 6 * W[k]! * ex * wallU
              else v = f[OPP[k]! * n + i]!
            } else {
              const src = ys * nx + xs
              if (solid[src]) {
                const outgoing = f[OPP[k]! * n + i]!
                v = outgoing
                const q = linkQ[k * n + i]!
                if (q < 0.5) {
                  const xn = x + ex; const yn = y + ey
                  if (xn >= 0 && xn < nx && yn >= 0 && yn < ny && !solid[yn * nx + xn]) v = 2 * q * outgoing + (1 - 2 * q) * f[OPP[k]! * n + yn * nx + xn]!
                } else if (q > 0.5) {
                  v = outgoing / (2 * q) + (2 * q - 1) / (2 * q) * f[k * n + i]!
                }
                // Momentum exchange on gauge populations (minus rest equilibrium) so bodies
                // touching a wall are not loaded by the absolute lattice pressure.
                fx -= ex * (outgoing + v - 2 * W[k]!)
                fy -= ey * (outgoing + v - 2 * W[k]!)
              } else {
                v = f[k * n + src]!
              }
            }
            fk[k] = v
            r += v; jx += ex * v; jy += ey * v
          }
          const u = jx / r
          const w = jy / r
          rho[i] = r; ux[i] = u; uy[i] = w
          rhoSum += r
          const usq = 1.5 * (u * u + w * w)
          let pxx = 0; let pyy = 0; let pxy = 0
          for (let k = 0; k < 9; k++) {
            const ex = EX[k]!; const ey = EY[k]!
            const eu = 3 * (ex * u + ey * w)
            const feq = W[k]! * r * (1 + eu + 0.5 * eu * eu - usq)
            fe[k] = feq
            const neq = fk[k]! - feq
            pxx += ex * ex * neq; pyy += ey * ey * neq; pxy += ex * ey * neq
          }
          let tau = tau0 + spongeTau[x]!
          if (smag > 0) {
            const q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy)
            tau = 0.5 * (tau + Math.sqrt(tau * tau + smag * q / r))
          }
          const keep = 1 - 1 / tau
          for (let k = 0; k < 9; k++) g[k * n + i] = fe[k]! + keep * (fk[k]! - fe[k]!)
        }
      }
    }
    // Absorbing far-field layers: relax towards the undisturbed free stream.
    const { absorbIndex, absorbSigma } = this
    for (let j = lowerBound(absorbIndex, y0 * nx), end = lowerBound(absorbIndex, (y1 + 1) * nx); j < end; j++) {
      const i = absorbIndex[j]!
      if (solid[i]) continue
      const s = absorbSigma[j]!
      for (let k = 0; k < 9; k++) { const o = k * n + i; g[o] = g[o]! + s * (target[k]! - g[o]!) }
    }
    // Side relief inside its bounding box (shared so helper threads see updates).
    const { ctrl } = this
    const rx0 = ctrl[4]!; const rx1 = ctrl[5]!
    for (let y = Math.max(y0, ctrl[6]!); y <= Math.min(y1, ctrl[7]!); y++) for (let x = rx0; x <= rx1; x++) {
      const i = y * nx + x
      const sr = relief[i]!
      if (!(sr > 0) || solid[i]) continue
      let r = 0; let jx = 0; let jy = 0
      for (let k = 0; k < 9; k++) { const v = g[k * n + i]!; r += v; jx += EX[k]! * v; jy += EY[k]! * v }
      const u = jx / r; const w = jy / r
      // Mass bleed: move local pressure towards ambient at fixed velocity, leaving the
      // shear (non-equilibrium) part untouched. Low-pressure wakes refill, as they do
      // from the sides of a 3D body.
      for (let k = 0; k < 9; k++) { const o = k * n + i; g[o] = g[o]! + sr * (equilibrium(k, 1, u, w) - equilibrium(k, r, u, w)) }
    }
    out[0] = fx; out[1] = fy; out[2] = rhoSum
  }
}

/** First index in the ascending array whose value is ≥ v. */
function lowerBound(a: Int32Array, v: number): number {
  let lo = 0; let hi = a.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid]! < v) lo = mid + 1; else hi = mid }
  return lo
}

/** Entry point for a helper thread: build a view onto the shared buffers and serve one band. */
export function runHelper(init: HelperInit) {
  const solver = new LbmSolver(init.options, undefined, init.buffers)
  solver.serveBand(init.band, init.y0, init.y1)
}

export function equilibrium(k: number, r: number, u: number, w: number): number {
  const eu = 3 * (EX[k]! * u + EY[k]! * w)
  return W[k]! * r * (1 + eu + 0.5 * eu * eu - 1.5 * (u * u + w * w))
}
