/**
 * International Standard Atmosphere (ISO 2533) up to 20 km:
 * troposphere with a −6.5 K/km lapse rate to 11 km, then an isothermal layer.
 */
export interface IsaState {
  altitudeM: number
  temperatureC: number
  pressurePa: number
  densityKgM3: number
  speedOfSoundMps: number
}

const R = 287.05287
const G0 = 9.80665
const T0 = 288.15
const P0 = 101325
const LAPSE = 0.0065
const TROPOPAUSE = 11000
const T11 = T0 - LAPSE * TROPOPAUSE
const P11 = P0 * (T11 / T0) ** (G0 / (R * LAPSE))

export const SEA_LEVEL_DENSITY = P0 / (R * T0)

export function isa(altitudeM: number): IsaState {
  const h = Math.min(20000, Math.max(-500, altitudeM))
  const temperatureK = h <= TROPOPAUSE ? T0 - LAPSE * h : T11
  const pressurePa = h <= TROPOPAUSE ? P0 * (temperatureK / T0) ** (G0 / (R * LAPSE)) : P11 * Math.exp(-G0 * (h - TROPOPAUSE) / (R * T11))
  return {
    altitudeM: h,
    temperatureC: temperatureK - 273.15,
    pressurePa,
    densityKgM3: pressurePa / (R * temperatureK),
    speedOfSoundMps: Math.sqrt(1.4 * R * temperatureK),
  }
}

/** Equivalent airspeed: the sea-level speed giving the same dynamic pressure. */
export const equivalentAirspeed = (trueAirspeedMps: number, densityKgM3: number) => trueAirspeedMps * Math.sqrt(densityKgM3 / SEA_LEVEL_DENSITY)

/** Prandtl lifting-line conversion of a 2D section lift coefficient to a finite wing (elliptic loading). */
export const finiteWingLift = (sectionCl: number, aspectRatio: number) => sectionCl * aspectRatio / (aspectRatio + 2)

/** Finite-wing lift slope per radian from thin-airfoil 2π and lifting-line theory. */
export const finiteWingLiftSlope = (aspectRatio: number) => 2 * Math.PI * aspectRatio / (aspectRatio + 2)

export interface FlightState { altitudeM: number; climbRateMps: number }
export interface FlightInputs { trueAirspeedMps: number; sectionCl: number; massKg: number; wingAreaM2: number; aspectRatio: number }

/**
 * One step of vertical (plunge) motion at constant airspeed and wing setting. Climbing
 * lowers the wing's effective angle of attack by w/V, which reduces lift: that is the
 * natural damping that makes a hands-off aircraft settle where lift equals weight.
 */
export function stepFlight(state: FlightState, inputs: FlightInputs, dt: number): FlightState {
  const { trueAirspeedMps: v, sectionCl, massKg, wingAreaM2, aspectRatio } = inputs
  if (!(v > 0) || !(massKg > 0)) return state
  let { altitudeM, climbRateMps } = state
  const slope = finiteWingLiftSlope(aspectRatio)
  // Sub-step so the plunge mode (time constant ~ m / (ρ V S a / 2)) stays stable.
  const n = Math.max(1, Math.ceil(dt / 0.02))
  for (let i = 0; i < n; i++) {
    const q = 0.5 * isa(altitudeM).densityKgM3 * v * v
    const cl = finiteWingLift(sectionCl, aspectRatio) - slope * climbRateMps / v
    climbRateMps += (q * wingAreaM2 * cl / massKg - 9.80665) * dt / n
    altitudeM += climbRateMps * dt / n
    if (altitudeM <= 0) { altitudeM = 0; climbRateMps = Math.max(0, climbRateMps) }
    if (altitudeM >= 20000) { altitudeM = 20000; climbRateMps = Math.min(0, climbRateMps) }
  }
  return { altitudeM, climbRateMps }
}

/** Altitude where lift equals weight at this speed and lift coefficient (null if none below 20 km). */
export function equilibriumAltitude(inputs: FlightInputs): number | null {
  const { trueAirspeedMps: v, sectionCl, massKg, wingAreaM2, aspectRatio } = inputs
  const cl = finiteWingLift(sectionCl, aspectRatio)
  if (!(cl > 0) || !(v > 0)) return null
  const neededDensity = 2 * massKg * 9.80665 / (wingAreaM2 * cl * v * v)
  if (neededDensity > isa(0).densityKgM3) return null
  let lo = 0; let hi = 20000
  if (neededDensity < isa(hi).densityKgM3) return null
  for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (isa(mid).densityKgM3 > neededDensity) lo = mid; else hi = mid }
  return (lo + hi) / 2
}
