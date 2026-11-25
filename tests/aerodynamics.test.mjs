import test from 'node:test'
import assert from 'node:assert/strict'
import { airDensityIdealGas, airViscositySutherland, dynamicPressurePa, machNumber, reynoldsNumber } from '../src/physics/aerodynamic-formulas.ts'
import { models } from '../src/features/model-library/models.ts'

test('unit-aware atmosphere and flow formulas return SI results', () => {
  assert.ok(Math.abs(airDensityIdealGas(101325, 20) - 1.2041) < 0.001)
  assert.equal(dynamicPressurePa(1.225, 30), 551.25)
  assert.ok(Math.abs(reynoldsNumber(1.225, 30, 1, 1.81e-5) - 2.0304e6) < 2e3)
  assert.ok(Math.abs(machNumber(30, 20) - 0.087) < 0.001)
})

test('Sutherland viscosity matches tabulated air values', () => {
  // ISA sea level (15 °C): 1.789e-5 Pa·s; 20 °C: 1.81e-5 Pa·s.
  assert.ok(Math.abs(airViscositySutherland(15) - 1.789e-5) < 0.01e-5)
  assert.ok(Math.abs(airViscositySutherland(20) - 1.813e-5) < 0.01e-5)
})

test('invalid inputs return NaN instead of numbers', () => {
  assert.ok(Number.isNaN(airDensityIdealGas(-1, 20)))
  assert.ok(Number.isNaN(reynoldsNumber(1.2, 30, 0, 1.8e-5)))
})

test('every library model has a positive reference length and area', () => {
  for (const model of models) {
    assert.ok(model.metadata.characteristicLengthM > 0)
    assert.ok(model.metadata.referenceAreaM2 > 0)
  }
})

test('temperature and pressure change density, viscosity and the Reynolds number', () => {
  const at = (pressurePa, temperatureC) => {
    const rho = airDensityIdealGas(pressurePa, temperatureC)
    return reynoldsNumber(rho, 30, 1, airViscositySutherland(temperatureC))
  }
  const base = at(101325, 20)
  assert.ok(at(101325, 60) < base * 0.85, 'hot air: lower density, higher viscosity → lower Re')
  assert.ok(at(50000, 20) < base * 0.55, 'half pressure → about half Re')
  assert.ok(at(101325, -30) > base * 1.25, 'cold air → higher Re')
})

test('standard atmosphere matches ISA tables', async () => {
  const { isa } = await import('../src/physics/atmosphere.ts')
  const sl = isa(0); const h5 = isa(5000); const h11 = isa(11000)
  assert.ok(Math.abs(sl.densityKgM3 - 1.225) < 0.001 && Math.abs(sl.temperatureC - 15) < 0.01)
  assert.ok(Math.abs(h5.densityKgM3 - 0.7364) < 0.002 && Math.abs(h5.pressurePa - 54048) < 60)
  assert.ok(Math.abs(h11.temperatureC + 56.5) < 0.05 && Math.abs(h11.pressurePa - 22632) < 30)
  assert.ok(Math.abs(sl.speedOfSoundMps - 340.29) < 0.1)
})

test('flight model settles where lift equals weight', async () => {
  const { stepFlight, equilibriumAltitude } = await import('../src/physics/atmosphere.ts')
  const inputs = { trueAirspeedMps: 240, sectionCl: 0.6, massKg: 200000, wingAreaM2: 360, aspectRatio: 9.5 }
  const target = equilibriumAltitude(inputs)
  assert.ok(target !== null && target > 3000 && target < 13000, `target ${target}`)
  let state = { altitudeM: 1000, climbRateMps: 0 }
  // Constant-pitch climb is overdamped: it creeps up to the balance altitude over ~an hour.
  for (let t = 0; t < 3600; t++) state = stepFlight(state, inputs, 1)
  assert.ok(Math.abs(state.altitudeM - target) < 10, `settled at ${state.altitudeM} vs ${target}`)
  assert.ok(Math.abs(state.climbRateMps) < 0.5)
})

test('flight presets set the wing for lift = weight at the target altitude', async () => {
  const { planFlight, liftModel } = await import('../src/features/flight/flight-plan.ts')
  const { finiteWingLift, isa } = await import('../src/physics/atmosphere.ts')
  const base = { changeM: 2000, baseAltitudeM: 3000, trueAirspeedMps: 850 / 3.6, massKg: 200000, wingAreaM2: 360, aspectRatio: 9.5 }
  for (const resolution of ['low', 'medium', 'high']) {
    const model = liftModel(resolution)
    const cruise = planFlight({ ...base, mode: 'cruise', model })
    const climb = planFlight({ ...base, mode: 'climb', model })
    const descend = planFlight({ ...base, mode: 'descend', model })
    assert.equal(cruise.targetAltitudeM, 3000); assert.equal(climb.targetAltitudeM, 5000); assert.equal(descend.targetAltitudeM, 1000)
    assert.ok(cruise.feasible && cruise.setting.config === 'clean', `${resolution} cruise ${JSON.stringify(cruise)}`)
    // Thinner air higher up needs more lift coefficient, so a steeper angle.
    assert.ok(climb.setting.angleOfAttackDeg >= cruise.setting.angleOfAttackDeg && cruise.setting.angleOfAttackDeg >= descend.setting.angleOfAttackDeg, resolution)
    const q = 0.5 * isa(5000).densityKgM3 * base.trueAirspeedMps ** 2
    assert.ok(Math.abs(q * 360 * finiteWingLift(climb.neededSectionCl, 9.5) - base.massKg * 9.80665) < 1)
    // Slow flight needs flaps; far too slow cannot be flown and says how fast it must go.
    const slow = planFlight({ ...base, mode: 'cruise', trueAirspeedMps: 420 / 3.6, massKg: 120000, baseAltitudeM: 0, model })
    assert.notEqual(slow.setting.config, 'clean', `${resolution} slow ${JSON.stringify(slow)}`)
    const crawl = planFlight({ ...base, mode: 'cruise', trueAirspeedMps: 150 / 3.6, model })
    assert.ok(!crawl.feasible && crawl.minAirspeedMps > 150 / 3.6)
  }
})

test('autopilot flies the wing: climbs and descends at the chosen rate, levels off exactly, holds altitude', async () => {
  const { flyAutopilot, liftModel } = await import('../src/features/flight/flight-plan.ts')
  const model = liftModel('medium')
  const fly = (target, rate, kmh, seconds = 900) => {
    let s = { altitudeM: 3000, climbRateMps: 0 }; let config = 'clean'; let peak = 0; let r
    const rates = []
    for (let t = 0; t < seconds; t += 2) {
      r = flyAutopilot(s, { targetAltitudeM: target, rateMps: rate, trueAirspeedMps: kmh / 3.6, massKg: 200000, wingAreaM2: 360, aspectRatio: 9.5, model, config }, 2)
      s = r.state; config = r.setting.config; rates.push(s.climbRateMps)
      peak = Math.max(peak, (target >= 3000 ? 1 : -1) * (s.altitudeM - target))
    }
    return { s, r, peak, rates }
  }
  const climb = fly(4500, 8, 700)
  assert.ok(Math.abs(climb.s.altitudeM - 4500) < 0.5 && Math.abs(climb.s.climbRateMps) < 0.01, JSON.stringify(climb.s))
  assert.ok(climb.peak < 0.5, `overshoot ${climb.peak} m`)
  assert.ok(Math.max(...climb.rates) > 7.9 && Math.max(...climb.rates) < 8.1, `climb rate ${Math.max(...climb.rates)}`)
  const descend = fly(1500, 5, 700)
  assert.ok(Math.abs(descend.s.altitudeM - 1500) < 0.5 && descend.peak < 0.5, JSON.stringify(descend.s))
  assert.ok(Math.min(...descend.rates) < -4.9 && Math.min(...descend.rates) > -5.1)
  const hold = fly(3000, 8, 700, 300)
  assert.ok(Math.abs(hold.s.altitudeM - 3000) < 0.01 && hold.r.saturated === 0)
  // Too slow: lift runs out, the autopilot says so instead of pretending.
  const slow = fly(3000, 8, 250, 60)
  assert.equal(slow.r.saturated, 1)
  assert.ok(slow.s.climbRateMps < 0)
})

test('climb estimate: time to target matches the rate, and a too-slow aircraft is reported as unable', async () => {
  const { estimateClimb, liftModel } = await import('../src/features/flight/flight-plan.ts')
  const base = { rateMps: 8, trueAirspeedMps: 700 / 3.6, massKg: 200000, wingAreaM2: 360, aspectRatio: 9.5, model: liftModel('medium'), config: null }
  const climb = estimateClimb(3000, { ...base, targetAltitudeM: 4000 })
  // 1,000 m at 8 m/s is 125 s, plus the gentle capture at both ends.
  assert.ok(climb.seconds > 125 && climb.seconds < 200 && !climb.limited, JSON.stringify(climb))
  assert.ok(Math.abs(climb.peakRateMps - 8) < 0.05)
  const slower = estimateClimb(3000, { ...base, targetAltitudeM: 4000, rateMps: 4 })
  assert.ok(slower.seconds > climb.seconds * 1.6)
  const descent = estimateClimb(3000, { ...base, targetAltitudeM: 2000, rateMps: 5 })
  assert.ok(descent.seconds > 200 && descent.peakRateMps < -4.9)
  const crawl = estimateClimb(3000, { ...base, targetAltitudeM: 4000, trueAirspeedMps: 250 / 3.6 })
  assert.ok(crawl.seconds === null && crawl.limited)
})

test('autopilot retracts slats and flaps once level when the clean wing can carry the weight', async () => {
  const { flyAutopilot, liftModel } = await import('../src/features/flight/flight-plan.ts')
  const model = liftModel('medium')
  const level = (kmh) => {
    let s = { altitudeM: 3000, climbRateMps: 0 }; let config = 'take-off flaps'; let r
    for (let t = 0; t < 300; t += 2) { r = flyAutopilot(s, { targetAltitudeM: 3000, rateMps: 8, trueAirspeedMps: kmh / 3.6, massKg: 200000, wingAreaM2: 360, aspectRatio: 9.5, model, config }, 2); s = r.state; config = r.setting.config }
    return { config, altitude: s.altitudeM }
  }
  const fast = level(700)
  assert.equal(fast.config, 'clean'); assert.ok(Math.abs(fast.altitude - 3000) < 1)
  // Too slow for the clean wing: the flaps have to stay out to hold altitude.
  const slow = level(450)
  assert.notEqual(slow.config, 'clean'); assert.ok(Math.abs(slow.altitude - 3000) < 1)
})
