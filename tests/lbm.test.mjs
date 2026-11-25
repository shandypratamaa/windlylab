import test from 'node:test'
import assert from 'node:assert/strict'
import { LbmSolver } from '../src/physics/lbm/lbm-solver.ts'
import { CfdSimulation } from '../src/physics/lbm/cfd-simulation.ts'
import { cfdBodyFor, computeLinkFractions, layoutBody, naca4, polygonGap, rasterize, tunnelFor } from '../src/physics/lbm/geometry.ts'
import { pressureLut } from '../src/features/cfd/colormaps.ts'

const EXTRA = { scale: 1, rearWingDeg: 10, slatDeg: null, flapDeg: null, sideRelief: false }
import { describeFlow } from '../src/features/cfd/flow-insights.ts'

test('Schäfer–Turek 2D-1 cylinder benchmark (Re = 20) with interpolated walls: drag within 6%', () => {
  // Schäfer & Turek (1996): channel H = 0.41, cylinder D = 0.1 at (0.2, 0.2), parabolic
  // inflow with mean speed 0.2. Reference Cd = 5.5795, Cl = 0.0106.
  const D = 16
  const scale = D / 0.1
  const nx = Math.round(2.2 * scale)
  const ny = Math.round(0.41 * scale)
  const umax = 0.1
  const ubar = umax * 2 / 3
  const solver = new LbmSolver({ nx, ny, inletVelocity: umax, viscosity: ubar * D / 20, smagorinsky: 0, inletProfile: 'parabolic', bottom: 'no-slip', top: 'no-slip', spongeCells: 1, rampSteps: 0 })
  const circle = Array.from({ length: 256 }, (_, i) => [0.2 * scale + D / 2 * Math.cos(2 * Math.PI * i / 256), 0.2 * scale + D / 2 * Math.sin(2 * Math.PI * i / 256)])
  const mask = rasterize([circle], nx, ny)
  solver.setSolid(mask, computeLinkFractions([circle], mask, nx, ny))
  solver.reset()
  assert.ok(solver.run(6000))
  // Normalise by the local density: the channel pressure drop raises it ~1% above the reference.
  let rho = 0; let count = 0
  const xc = Math.round(0.2 * scale)
  for (let y = 0; y < ny; y++) if (!mask[y * nx + xc]) { rho += solver.rho[y * nx + xc]; count++ }
  rho /= count
  const cd = 2 * solver.forceX / (rho * ubar * ubar * D)
  const cl = 2 * solver.forceY / (rho * ubar * ubar * D)
  assert.ok(Math.abs(cd - 5.5795) / 5.5795 < 0.06, `Cd = ${cd}`)
  assert.ok(Math.abs(cl - 0.0106) < 0.005, `Cl = ${cl}`)
})

test('interpolated bounce-back with q = 0.5 everywhere reproduces halfway bounce-back exactly', () => {
  const nx = 80; const ny = 40
  const mask = new Uint8Array(nx * ny)
  for (let y = 15; y < 25; y++) for (let x = 20; x < 30; x++) mask[y * nx + x] = 1
  const a = new LbmSolver({ nx, ny, inletVelocity: 0.05, viscosity: 0.05, smagorinsky: 0 })
  const b = new LbmSolver({ nx, ny, inletVelocity: 0.05, viscosity: 0.05, smagorinsky: 0 })
  a.setSolid(mask); b.setSolid(mask, new Float32Array(9 * nx * ny).fill(0.5))
  a.reset(); b.reset(); a.run(300); b.run(300)
  assert.equal(a.forceX, b.forceX)
})

test('velocity inlet delivers the prescribed volume flux', () => {
  const nx = 120; const ny = 40
  const solver = new LbmSolver({ nx, ny, inletVelocity: 0.08, viscosity: 0.05, smagorinsky: 0, rampSteps: 0 })
  solver.run(1500)
  let flux = 0
  for (let y = 0; y < ny; y++) flux += solver.ux[y * nx + 30] * solver.rho[y * nx + 30] / solver.rho[y * nx]
  assert.ok(Math.abs(flux / ny - 0.08) / 0.08 < 0.02, `mean u = ${flux / ny}`)
})

test('momentum exchange ignores uniform pressure on a body touching a wall', () => {
  // A block resting on a no-slip floor in still fluid must feel no net force.
  const nx = 60; const ny = 30
  const solver = new LbmSolver({ nx, ny, inletVelocity: 0, viscosity: 0.1, smagorinsky: 0, bottom: 'no-slip', rampSteps: 0 })
  const mask = new Uint8Array(nx * ny)
  for (let y = 0; y < 6; y++) for (let x = 25; x < 35; x++) mask[y * nx + x] = 1
  solver.setSolid(mask)
  solver.reset()
  solver.run(20)
  assert.ok(Math.abs(solver.forceY) < 1e-4, `Fy = ${solver.forceY}`)
})

test('NACA 4-digit generator and rasteriser produce a closed section of the right thickness', () => {
  const section = naca4('0012')
  const thickness = Math.max(...section.map(p => p[1])) - Math.min(...section.map(p => p[1]))
  assert.ok(Math.abs(thickness - 0.12) < 0.002)
  const cells = 100
  const mask = rasterize([section.map(([x, y]) => [x * cells + 10, y * cells + 20])], 130, 40)
  const area = mask.reduce((sum, v) => sum + v, 0)
  // NACA 00xx area ≈ 0.685 · t · c².
  assert.ok(Math.abs(area - 0.685 * 0.12 * cells * cells) / (0.685 * 0.12 * cells * cells) < 0.08, `area = ${area}`)
})

test('symmetric airfoil at zero incidence has ~zero lift; positive incidence gives positive lift', () => {
  const run = angleOfAttackDeg => {
    const sim = new CfdSimulation({ kind: 'aircraft-wing', airfoil: '0012', angleOfAttackDeg, resolution: 'low', reynolds: 500, smokeLines: 8, ...EXTRA })
    sim.advance(4500, false)
    return sim.stats()
  }
  const zero = run(0)
  const four = run(5)
  assert.ok(!zero.diverged && !four.diverged)
  assert.ok(Math.abs(zero.clMean) < 0.03, `Cl(0°) = ${zero.clMean}`)
  assert.ok(four.clMean > 0.12, `Cl(5°) = ${four.clMean}`)
  assert.ok(zero.cdMean > 0.03 && zero.cdMean < 0.3, `Cd(0°) = ${zero.cdMean}`)
})

test('separation detector: attached at 0°, separated near the leading edge at 16°', () => {
  const run = angleOfAttackDeg => {
    const sim = new CfdSimulation({ kind: 'aircraft-wing', airfoil: '0012', angleOfAttackDeg, resolution: 'low', reynolds: 3000, smokeLines: 8, ...EXTRA })
    sim.advance(6000, 'none')
    return sim.stats()
  }
  const zero = run(0)
  const high = run(16)
  assert.equal(zero.suction?.separation ?? null, null)
  assert.ok(high.suction && high.suction.separation !== null && high.suction.separation < 0.4, `separation at ${high.suction?.separation}`)
  const headline = describeFlow(high, { family: 'airfoil', angleOfAttackDeg: 16, hasRearWing: false })[0]
  assert.ok(headline.id === 'stalling' || headline.id === 'stalled', headline.id)
  assert.equal(describeFlow(zero, { family: 'airfoil', angleOfAttackDeg: 0, hasRearWing: false })[0].id, 'attached-zero')
})

test('realistic smoke stays bounded between 0 and 1 and is carried downstream', () => {
  const sim = new CfdSimulation({ kind: 'cylinder', airfoil: '0012', angleOfAttackDeg: 0, resolution: 'low', reynolds: 200, smokeLines: 10, ...EXTRA })
  sim.advance(1500, 'dye')
  let max = 0; let min = 1; let downstream = 0
  const { nx, ny } = sim.layout
  for (let i = 0; i < sim.dye.length; i++) { max = Math.max(max, sim.dye[i]); min = Math.min(min, sim.dye[i]) }
  for (let y = 0; y < ny; y++) downstream += sim.dye[y * nx + Math.round(nx * 0.25)]
  assert.ok(min >= 0 && max <= 1.0001, `range ${min}..${max}`)
  assert.ok(downstream > 1, `dye reaching x = nx/4: ${downstream}`)
})

test('flow insights report vortex shedding for a bluff body and diverged runs', () => {
  const base = { step: 1, flowThroughs: 3, settled: true, cd: 1.4, cl: 0, cdMean: 1.4, clMean: 0, cdStd: 0.02, clStd: 0.4, strouhal: 0.2, reynolds: 150, maxReynolds: 2000, blockage: 0.1, latticeNu: 0.01, tau: 0.53, diverged: false, forceLengthLabel: 'diameter', suction: null, pressureSide: null }
  assert.equal(describeFlow(base, { family: 'bluff', angleOfAttackDeg: 0, hasRearWing: false })[0].id, 'karman')
  assert.equal(describeFlow({ ...base, diverged: true }, { family: 'bluff', angleOfAttackDeg: 0, hasRearWing: false })[0].id, 'diverged')
})

const KINDS = ['aircraft-wing', 'plate', 'cylinder', 'sphere', 'cube', 'wedge', 'suv', 'coupe', 'sports', 'spoiler', 'wing', 'race']

test('every model starts under 5% tunnel blockage at scale 1×, and the scale slider resizes the body', () => {
  for (const kind of KINDS) {
    const tunnel = tunnelFor(kind, '2412', 72, 12)
    const at = scale => layoutBody(cfdBodyFor(kind, { airfoil: '2412', scale: tunnel.defaultScale * scale }), tunnel, 4)
    const base = at(1)
    assert.ok(base.blockage < 0.05, `${kind} blockage ${base.blockage}`)
    const big = at(2)
    assert.ok(big.blockage > base.blockage * 1.8, `${kind} scale 2× blockage ${big.blockage}`)
    assert.ok(big.mask.reduce((a, v) => a + v, 0) > base.mask.reduce((a, v) => a + v, 0) * 3, `${kind} solid area grows`)
  }
})

test('rear wing angle tilts only the wing', () => {
  for (const kind of ['spoiler', 'wing', 'race']) {
    const flat = cfdBodyFor(kind, { rearWingDeg: 0 })
    const steep = cfdBodyFor(kind, { rearWingDeg: 25 })
    const last = body => body.polygons[body.polygons.length - 1]
    assert.deepEqual(flat.polygons[0], steep.polygons[0], `${kind} body unchanged`)
    assert.notDeepEqual(last(flat), last(steep), `${kind} wing moved`)
  }
})

for (const [slatDeg, flapDeg] of [[6, 6], [15, 10], [25, 30], [30, 40]]) test(`slat ${slatDeg}° / flap ${flapDeg}°: separate elements with an open slot of at least 2 cells on the high grid`, () => {
  const tunnel = tunnelFor('aircraft-wing', '2412', 100, 18)
  const body = cfdBodyFor('aircraft-wing', { airfoil: '2412', scale: tunnel.defaultScale, slatDeg, flapDeg, flapType: 'single' })
  assert.equal(body.polygons.length, 3)
  for (const other of [1, 2]) assert.ok(Math.abs(polygonGap(body.polygons[0], body.polygons[other]) - 0.03 * tunnel.defaultScale) < 1e-3, 'slot is SLOT_GAP wide')
  const layout = layoutBody(body, tunnel, 4)
  const masks = layout.polygons.map(poly => rasterize([poly], layout.nx, layout.ny))
  // Smallest Chebyshev distance between solid cells of different elements.
  const cells = masks.map(m => { const list = []; m.forEach((v, i) => { if (v) list.push([i % layout.nx, Math.floor(i / layout.nx)]) }); return list })
  for (const other of [1, 2]) {
    let best = Infinity
    for (const [ax, ay] of cells[0]) for (const [bx, by] of cells[other]) best = Math.min(best, Math.max(Math.abs(ax - bx), Math.abs(ay - by)))
    assert.ok(best >= 3, `gap to element ${other}: ${best - 1} open cells`)
  }
})

test('side relief stays stable and keeps car forces in a sane range', () => {
  const run = sideRelief => {
    const sim = new CfdSimulation({ kind: 'sports', airfoil: '2412', angleOfAttackDeg: 0, resolution: 'low', reynolds: 1e6, smokeLines: 6, ...EXTRA, sideRelief })
    sim.advance(9000, 'none')
    return sim.stats()
  }
  const off = run(false)
  const on = run(true)
  assert.ok(!on.diverged && !off.diverged)
  // With air flowing under the floor the 2D slice no longer has the extreme lift relief was
  // built to cancel; relief now nudges forces either way, so only check they stay plausible.
  for (const s of [off, on]) assert.ok(s.cdMean > 0.2 && s.cdMean < 2.5 && Math.abs(s.clMean) < 3, `Cd ${s.cdMean}, Cl ${s.clMean}`)
})

test('pressure colour map is blue for low, white at ambient, red for high', () => {
  const at = i => [pressureLut[i * 3], pressureLut[i * 3 + 1], pressureLut[i * 3 + 2]]
  const [lr, , lb] = at(10); const mid = at(128); const [hr, , hb] = at(245)
  assert.ok(lb > lr, 'low end is blue')
  assert.ok(mid.every(c => c > 245), `centre is white: ${mid}`)
  assert.ok(hr > hb, 'high end is red')
})

test('adjusting slat, flap or angle eases the body over time and never moves the smoke wands', () => {
  const base = { kind: 'aircraft-wing', airfoil: '2412', angleOfAttackDeg: 4, resolution: 'low', reynolds: 2000, smokeLines: 20, scale: 1, rearWingDeg: 10, slatDeg: 20, flapDeg: 10, sideRelief: false }
  const sim = new CfdSimulation(base)
  sim.advance(100, 'dye')
  const wands = JSON.stringify(sim.emitters)
  sim.configure({ ...base, flapDeg: 35, slatDeg: 30, angleOfAttackDeg: 10 })
  assert.equal(sim.transitioning, true)
  sim.advance(40, 'dye')
  assert.equal(sim.transitioning, true, 'a 25° flap change takes more than two geometry steps')
  let steps = 0
  while (sim.transitioning && steps < 2000) { sim.advance(20, 'dye'); steps += 20 }
  assert.equal(sim.transitioning, false)
  assert.equal(JSON.stringify(sim.emitters), wands)
  assert.ok(!sim.solver.diverged)
})

test('flap kinematics: deflecting moves the trailing edge down and the nose aft, staying under the main trailing edge', () => {
  const at = flapDeg => {
    const flap = cfdBodyFor('aircraft-wing', { airfoil: '2412', scale: 1, slatDeg: null, flapDeg }).polygons[1]
    const te = flap.reduce((a, p) => p[0] > a[0] ? p : a)
    const le = flap.reduce((a, p) => p[0] < a[0] ? p : a)
    return { te, le }
  }
  const main = cfdBodyFor('aircraft-wing', { airfoil: '2412', scale: 1, slatDeg: null, flapDeg: 0 }).polygons[0]
  const mainTeX = Math.max(...main.map(p => p[0]))
  let prev = at(0)
  assert.ok(prev.le[0] < mainTeX, 'retracted flap nose is tucked under the main element')
  for (const d of [10, 20, 30, 40]) {
    const cur = at(d)
    assert.ok(cur.te[1] < prev.te[1], `trailing edge lower at ${d}°`)
    assert.ok(cur.le[0] >= prev.le[0] - 1e-6, `nose moves aft at ${d}°`)
    prev = cur
  }
})

test('double-slotted flap: fore and aft flap, every slot exactly 3% chord, at all deployed deflections', () => {
  for (const flapDeg of [10, 20, 30, 40]) {
    const body = cfdBodyFor('aircraft-wing', { airfoil: '2412', scale: 1, slatDeg: 20, flapDeg, flapType: 'double' })
    assert.equal(body.polygons.length, 4, 'main, slat, vane, aft flap')
    const [main, slat, vane, aft] = body.polygons
    assert.ok(Math.abs(polygonGap(main, slat) - 0.03) < 1e-3, `slat slot at ${flapDeg}°`)
    assert.ok(Math.abs(polygonGap(main, vane) - 0.03) < 1e-3, `vane slot at ${flapDeg}°`)
    const aftGap = Math.min(polygonGap(main, aft), polygonGap(vane, aft))
    assert.ok(Math.abs(aftGap - 0.03) < 1e-3, `aft-flap slot at ${flapDeg}°: ${aftGap}`)
  }
})

test('geometry easing runs on the wall clock: a 30° flap move completes in about a third of a second', () => {
  const base = { kind: 'aircraft-wing', airfoil: '2412', angleOfAttackDeg: 4, resolution: 'low', reynolds: 2000, smokeLines: 10, scale: 1, rearWingDeg: 10, slatDeg: null, flapDeg: 0, flapType: 'single', sideRelief: false }
  const sim = new CfdSimulation(base)
  sim.advance(40, 'none')
  sim.configure({ ...base, flapDeg: 30 })
  const t0 = performance.now()
  while (sim.transitioning && performance.now() - t0 < 3000) sim.advance(8, 'none')
  const seconds = (performance.now() - t0) / 1000
  // 90°/s → 30° in 1/3 s, independent of how fast the solver runs.
  assert.ok(!sim.transitioning && seconds < 0.6, `took ${seconds.toFixed(2)} s`)
  assert.ok(!sim.solver.diverged)
})

test('geometry keeps easing after a restart or a fresh rebuild (step counter resets)', () => {
  const base = { kind: 'aircraft-wing', airfoil: '2412', angleOfAttackDeg: 4, resolution: 'low', reynolds: 2000, smokeLines: 10, scale: 1, rearWingDeg: 10, slatDeg: null, flapDeg: 0, flapType: 'single', sideRelief: false }
  const sim = new CfdSimulation(base)
  sim.advance(3000, 'none')
  // Fresh rebuild (flap type change) then a flap move.
  sim.configure({ ...base, flapType: 'double' })
  sim.configure({ ...base, flapType: 'double', flapDeg: 30 })
  sim.advance(400, 'none')
  assert.equal(sim.transitioning, false, 'flap reached 30° after switching flap type')
  // Restart flow, then move again.
  sim.reset()
  sim.configure({ ...base, flapType: 'double', flapDeg: 10 })
  sim.advance(400, 'none')
  assert.equal(sim.transitioning, false, 'flap reached 10° after restarting the flow')
})

test('stowed (cruise) configuration packs slat and flaps into the clean airfoil outline', () => {
  const clean = cfdBodyFor('aircraft-wing', { airfoil: '2412', scale: 1 }).polygons[0]
  const stowed = cfdBodyFor('aircraft-wing', { airfoil: '2412', scale: 1, slatDeg: 0, flapDeg: 0, flapType: 'double' })
  assert.deepEqual(stowed.roles, ['main', 'slat', 'flap', 'flap'])
  const box = poly => ({ x0: Math.min(...poly.map(p => p[0])), x1: Math.max(...poly.map(p => p[0])), y0: Math.min(...poly.map(p => p[1])), y1: Math.max(...poly.map(p => p[1])) })
  const c = box(clean); const all = box(stowed.polygons.flat())
  for (const k of ['x0', 'x1', 'y0', 'y1']) assert.ok(Math.abs(c[k] - all[k]) < 0.01, `${k}: clean ${c[k]} vs stowed ${all[k]}`)
  // Slat sits flush on the nose.
  assert.ok(polygonGap(stowed.polygons[0], stowed.polygons[1]) < 0.002)
})

test('small adjustments of developed flow re-settle in under half the time; a fresh start waits the full 1.2 flow-throughs', () => {
  const p = { kind: 'aircraft-wing', airfoil: '2412', angleOfAttackDeg: 4, resolution: 'low', reynolds: 3000, smokeLines: 4, scale: 1, rearWingDeg: 10, slatDeg: 0, flapDeg: 0, flapType: 'double', sideRelief: false }
  const sim = new CfdSimulation(p)
  assert.equal(sim.stats().settleFlowThroughs, 1.2)
  sim.advance(Math.round(1.25 * sim.layout.nx / 0.1), 'none')
  assert.ok(sim.stats().settled)
  // A 0.5° autopilot tweak: short re-settle, averages back within ~0.5 flow-throughs.
  sim.configure({ ...p, angleOfAttackDeg: 4.5 })
  while (sim.transitioning) sim.advance(8, 'none')
  const small = sim.stats().settleFlowThroughs
  assert.ok(small >= 0.45 && small <= 0.5, `small change waits ${small}`)
  sim.advance(Math.round(0.51 * sim.layout.nx / 0.1), 'none')
  assert.ok(sim.stats().settled && Number.isFinite(sim.stats().clMean))
  // Deploying flaps changes the near field more, so it waits longer (but less than a fresh start).
  sim.configure({ ...p, angleOfAttackDeg: 4.5, slatDeg: 18, flapDeg: 20 })
  while (sim.transitioning) sim.advance(8, 'none')
  const big = sim.stats().settleFlowThroughs
  assert.ok(big > small && big < 1.2, `flap deployment waits ${big}`)
  sim.reset()
  assert.equal(sim.stats().settleFlowThroughs, 1.2)
})

test('cars keep at least 3 cells of air under the floor, so wing and race cars give sane forces', () => {
  for (const kind of ['suv', 'coupe', 'sports', 'spoiler', 'wing', 'race']) {
    for (const resolution of ['low', 'medium']) {
      const sim = new CfdSimulation({ kind, airfoil: '2412', angleOfAttackDeg: 0, resolution, reynolds: 1e6, smokeLines: 4, ...EXTRA, sideRelief: false })
      const floor = Math.min(...sim.layout.polygons[0].map(p => p[1]))
      assert.ok(floor >= 2.99, `${kind} ${resolution}: floor gap ${floor} cells`)
    }
  }
  // The large-wing car used to read Cl ≈ 9 on the Medium grid from air choked under its floor.
  const sim = new CfdSimulation({ kind: 'wing', airfoil: '2412', angleOfAttackDeg: 0, resolution: 'low', reynolds: 1e6, smokeLines: 4, ...EXTRA, sideRelief: false })
  sim.advance(Math.round(1.3 * sim.layout.nx / 0.1), 'none')
  const s = sim.stats()
  assert.ok(!s.diverged && Math.abs(s.clMean) < 2.5 && s.cdMean > 0 && s.cdMean < 3, `wing car Cd ${s.cdMean}, Cl ${s.clMean}`)
})
