import test from 'node:test'
import assert from 'node:assert/strict'
import { flowVelocity, solvePanelFlow } from '../src/features/cfd/panel-flow.ts'
import { cfdBodyFor, naca4 } from '../src/physics/lbm/geometry.ts'

const pitch = (polys, deg) => { const a = -deg * Math.PI / 180; const c = Math.cos(a), s = Math.sin(a); return polys.map(p => p.map(([x, y]) => [x * c - y * s, x * s + y * c])) }
const panels = (_, perimeter) => Math.max(22, Math.round(perimeter * 65))

test('vortex panel method matches inviscid aerofoil lift (NACA 0012, 2412)', () => {
  // Inviscid panel-method values: thickness adds ~10% over thin-aerofoil theory.
  const cl = (code, deg) => solvePanelFlow(pitch([naca4(code)], deg), panels).cl
  assert.ok(Math.abs(cl('0012', 0)) < 0.01)
  assert.ok(Math.abs(cl('0012', 5) - 0.61) < 0.03, `0012 @5°: ${cl('0012', 5)}`)
  assert.ok(Math.abs(cl('2412', 4) - 0.75) < 0.04, `2412 @4°: ${cl('2412', 4)}`)
  // Lift slope close to 2π per radian (+ thickness).
  const slope = (cl('2412', 6) - cl('2412', 2)) / (4 * Math.PI / 180)
  assert.ok(slope > 2 * Math.PI && slope < 2 * Math.PI * 1.15, `slope ${slope}`)
})

test('slat and flaps add lift, the flow is tangent to the wing, and air passes through the slots', () => {
  const flow = (slat, flap, deg) => {
    const body = cfdBodyFor('aircraft-wing', { airfoil: '2412', slatDeg: slat, flapDeg: flap, flapType: 'double' })
    return { f: solvePanelFlow(pitch(body.polygons, deg), panels), polys: pitch(body.polygons, deg), roles: body.roles }
  }
  const clean = solvePanelFlow(pitch([naca4('2412')], 6), panels).cl
  const takeOff = flow(18, 20, 6); const landing = flow(25, 35, 6)
  assert.ok(takeOff.f.cl > clean + 0.6 && landing.f.cl > takeOff.f.cl, `clean ${clean}, take-off ${takeOff.f.cl}, landing ${landing.f.cl}`)
  // Streamlines released at the far left pass through the slots, and very few run into
  // the wing (in potential flow none should; the panelling allows a little leakage at corners).
  const v = new Float64Array(2)
  const inside = (p, poly) => { let h = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) h = !h } return h }
  for (const config of [takeOff, landing]) {
    let hits = 0; let lines = 0
    for (let y0 = -0.4; y0 <= 0.2; y0 += 0.01) {
      lines++
      let p = [-2, y0]
      for (let k = 0; k < 2500 && p[0] < 2; k++) {
        flowVelocity(config.f, p[0], p[1], v); const sp = Math.hypot(v[0], v[1]) || 1
        p = [p[0] + 0.006 * v[0] / sp, p[1] + 0.006 * v[1] / sp]
        if (config.polys.some(q => inside(p, q))) { hits++; break }
      }
    }
    assert.ok(hits / lines < 0.2, `${hits} of ${lines} streamlines ran into the wing`)
  }
  // Air really flows through the slat slot: midway between the slat's trailing edge and the main wing it moves downstream fast.
  const slat = landing.polys[landing.roles.indexOf('slat')]; const main = landing.polys[landing.roles.indexOf('main')]
  const te = slat.reduce((a, p) => (p[0] > a[0] ? p : a))
  const nearest = main.reduce((a, p) => (Math.hypot(p[0] - te[0], p[1] - te[1]) < Math.hypot(a[0] - te[0], a[1] - te[1]) ? p : a))
  flowVelocity(landing.f, (te[0] + nearest[0]) / 2, (te[1] + nearest[1]) / 2, v)
  assert.ok(v[0] > 1, `slot flow ${v[0]}, ${v[1]}`)
})
