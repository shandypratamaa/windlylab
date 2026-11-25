import { finiteWingLift, finiteWingLiftSlope, isa, type FlightState } from '../../physics/atmosphere.ts'
import type { CfdResolution } from '../../physics/lbm/cfd-simulation.ts'
import { LIFT_TABLE, type LiftPoint } from './lift-table.ts'

export type FlightMode = 'cruise' | 'climb' | 'descend'
export type ConfigName = 'clean' | 'take-off flaps' | 'landing flaps'

/** Wing configurations, cleanest first: angle of attack is varied within each. */
const CONFIGS: { name: ConfigName; slat: number; flap: number; separationLimit: number }[] = [
  { name: 'clean', slat: 0, flap: 0, separationLimit: 0.55 },
  { name: 'take-off flaps', slat: 18, flap: 20, separationLimit: 0.35 },
  { name: 'landing flaps', slat: 20, flap: 30, separationLimit: 0.35 },
]
/** Keep this much lift in reserve below the highest measured unstalled lift. */
const MARGIN = 0.95
/** In level flight a configuration is used up to this share of its maximum lift before flaps are kept out. */
const LEVEL_MARGIN = 0.97
/** A cleaner configuration is chosen again once the lift needed drops below this share of its maximum. */
const RETRACT_SHARE = 0.93
const MAX_ALTITUDE = 13000

export interface WingSetting { angleOfAttackDeg: number; slatDeg: number; flapDeg: number; config: ConfigName }

/** One configuration's lift line Cl = cl0 + slope·α (including any measured CFD bias) and its usable range. */
export interface ConfigLine {
  name: ConfigName; slat: number; flap: number
  cl0: number; slope: number
  aoaMin: number; aoaMax: number
  clMin: number; clMax: number
}
export type LiftModel = ConfigLine[]
/** Per-configuration correction (live CFD lift − table lift), learned while flying. */
export type LiftBias = Partial<Record<ConfigName, number>>

/**
 * Fit a lift line to one configuration's measured points: from the first working
 * point (a deployed slat at low angles can leave the nose flow broken) up to the
 * highest lift before the first stall. A least-squares line smooths the scatter of
 * the time-averaged low-Reynolds-number results.
 */
function fitLine(points: LiftPoint[], slat: number, flap: number, separationLimit: number) {
  const curve = points.filter(p => p.slat === slat && p.flap === flap).sort((a, b) => a.aoa - b.aoa)
  const stalled = (p: LiftPoint) => p.diverged || (p.sep !== null && p.sep < separationLimit)
  const start = curve.findIndex(p => !stalled(p))
  if (start < 0) return null
  let end = start
  while (end + 1 < curve.length && !stalled(curve[end + 1]!)) end++
  let top = start
  for (let k = start; k <= end; k++) if (curve[k]!.cl > curve[top]!.cl) top = k
  const used = curve.slice(start, top + 1)
  if (used.length < 2) return null
  const n = used.length
  const mx = used.reduce((t, p) => t + p.aoa, 0) / n; const my = used.reduce((t, p) => t + p.cl, 0) / n
  const sxx = used.reduce((t, p) => t + (p.aoa - mx) ** 2, 0); const sxy = used.reduce((t, p) => t + (p.aoa - mx) * (p.cl - my), 0)
  const slope = sxy / sxx > 0.01 ? sxy / sxx : 0.08
  return { cl0: my - slope * mx, slope, aoaMin: used[0]!.aoa - 2, aoaTop: used[n - 1]!.aoa }
}

/** Lift lines for every configuration on this grid, shifted by the learned bias. */
export function liftModel(resolution: CfdResolution, bias: LiftBias = {}): LiftModel {
  const model: LiftModel = []
  for (const c of CONFIGS) {
    const fit = fitLine(LIFT_TABLE[resolution], c.slat, c.flap, c.separationLimit)
    if (!fit) continue
    const cl0 = fit.cl0 + (bias[c.name] ?? 0)
    const clMax = (cl0 + fit.slope * fit.aoaTop) * MARGIN
    model.push({ name: c.name, slat: c.slat, flap: c.flap, cl0, slope: fit.slope, aoaMin: fit.aoaMin, aoaMax: (clMax - cl0) / fit.slope, clMin: cl0 + fit.slope * fit.aoaMin, clMax })
  }
  return model
}

/** Table lift (without bias) of a configuration at an angle, used to learn the bias from the CFD. */
export function tableCl(resolution: CfdResolution, config: ConfigName, aoa: number): number | null {
  const line = liftModel(resolution).find(l => l.name === config)
  return line ? line.cl0 + line.slope * aoa : null
}

/** The configuration these slat/flap angles correspond to, if any. */
export function configOf(slatDeg: number, flapDeg: number): ConfigName | null {
  return CONFIGS.find(c => c.slat === slatDeg && c.flap === flapDeg)?.name ?? null
}

/** Section lift the model gives for a wing setting (null if the slat/flap angles are not a known configuration). */
export function sectionClFor(model: LiftModel, s: { angleOfAttackDeg: number; slatDeg: number; flapDeg: number }): number | null {
  const line = model.find(l => l.slat === s.slatDeg && l.flap === s.flapDeg)
  return line ? line.cl0 + line.slope * s.angleOfAttackDeg : null
}

/**
 * Wing setting (configuration + angle of attack) that makes this section lift.
 * Stays in the current configuration while it can, retracts to a cleaner one when
 * that has comfortable margin, and extends slats/flaps only when needed.
 * `saturated` is +1 / −1 when the lift asked for is above / below what the wing can make.
 */
export function settingForCl(model: LiftModel, cl: number, current: ConfigName | null = null, preferClean = false): { setting: WingSetting; saturated: -1 | 0 | 1 } {
  const at = (l: ConfigLine, saturated: -1 | 0 | 1) => {
    const aoa = Math.max(l.aoaMin, Math.min(l.aoaMax, (cl - l.cl0) / l.slope))
    return { setting: { angleOfAttackDeg: aoa, slatDeg: l.slat, flapDeg: l.flap, config: l.name }, saturated }
  }
  // Level flight: use the cleanest setting that can carry the weight (least drag), keeping a small margin from its limit.
  if (preferClean) {
    const clean = model.find(l => cl <= l.clMax * LEVEL_MARGIN && cl >= l.clMin)
    if (clean) return at(clean, 0)
  }
  const index = model.findIndex(l => l.name === current)
  const cleaner = model.find((l, k) => index >= 0 && k < index && cl <= l.clMax * RETRACT_SHARE && cl >= l.clMin)
  if (cleaner) return at(cleaner, 0)
  if (index >= 0 && cl <= model[index]!.clMax && cl >= model[index]!.clMin) return at(model[index]!, 0)
  const fits = model.find(l => cl <= l.clMax && cl >= l.clMin)
  if (fits) return at(fits, 0)
  if (cl < model[0]!.clMin) return at(model[0]!, -1)
  const strongest = model.reduce((x, y) => (y.clMax > x.clMax ? y : x))
  return at(strongest, 1)
}

export interface PlanInputs {
  mode: FlightMode
  /** Altitude to gain (climb) or lose (descend), metres. Ignored for cruise. */
  changeM: number
  /** Altitude the preset starts from (where the aircraft is when it is chosen). */
  baseAltitudeM: number
  trueAirspeedMps: number
  massKg: number
  wingAreaM2: number
  aspectRatio: number
  model: LiftModel
}

export interface FlightPlan {
  targetAltitudeM: number
  /** 2D section lift coefficient the wing needs for lift = weight at the target altitude. */
  neededSectionCl: number
  setting: WingSetting
  /** False when even the landing configuration cannot make enough lift at this speed. */
  feasible: boolean
  /** Slowest true airspeed at which the best configuration still carries the weight at the target altitude. */
  minAirspeedMps: number
}

const sectionFromWing = (wingCl: number, aspectRatio: number) => wingCl * (aspectRatio + 2) / aspectRatio

/**
 * Flight presets. Cruise keeps the current altitude; climb and descend aim for it ± the
 * chosen change. The plan is the wing setting whose lift equals the weight at the
 * target altitude and airspeed: hands-off, the aircraft drifts there and settles
 * (thinner or denser air brings lift back to weight). With the autopilot on it flies
 * there at the chosen vertical rate instead.
 */
export function planFlight(i: PlanInputs): FlightPlan {
  const change = i.mode === 'climb' ? i.changeM : i.mode === 'descend' ? -i.changeM : 0
  const targetAltitudeM = Math.max(0, Math.min(MAX_ALTITUDE, i.baseAltitudeM + change))
  const rho = isa(targetAltitudeM).densityKgM3
  const v = Math.max(1, i.trueAirspeedMps)
  const weight = i.massKg * 9.80665
  const neededSectionCl = sectionFromWing(weight / (0.5 * rho * v * v * i.wingAreaM2), i.aspectRatio)
  const { setting, saturated } = settingForCl(i.model, neededSectionCl)
  const clMax = Math.max(...i.model.map(l => l.clMax))
  const minAirspeedMps = Math.sqrt(2 * weight / (rho * i.wingAreaM2 * finiteWingLift(clMax, i.aspectRatio)))
  return { targetAltitudeM, neededSectionCl, setting, feasible: saturated !== 1, minAirspeedMps }
}

export interface AutopilotInputs {
  targetAltitudeM: number
  /** Largest climb or descent rate the autopilot may fly, m/s. */
  rateMps: number
  trueAirspeedMps: number
  massKg: number
  wingAreaM2: number
  aspectRatio: number
  model: LiftModel
  /** Configuration currently set, so slats and flaps don't hunt back and forth. */
  config: ConfigName | null
}

export interface AutopilotResult { state: FlightState; setting: WingSetting; saturated: -1 | 0 | 1; commandedRateMps: number }

/** Gains: wanted vertical speed per metre of altitude error, and how fast the vertical speed is corrected (1/s). */
const ALTITUDE_GAIN = 0.08
/** Within this many metres of the target (and nearly level) the autopilot counts as levelled off. */
const LEVEL_BAND_M = 25
const RATE_GAIN = 0.6

/**
 * Altitude-hold / vertical-speed autopilot that flies the wing itself. Each 0.02 s it
 * picks a vertical speed (the chosen rate, easing off near the target so the level-off
 * is exact and does not overshoot), works out the lift that gives it, including the
 * angle the wing loses while climbing (w/V), and sets the angle of attack, slat and
 * flaps that make that lift. The same lift then moves the aircraft.
 */
export function flyAutopilot(start: FlightState, i: AutopilotInputs, dt: number): AutopilotResult {
  const v = Math.max(1, i.trueAirspeedMps)
  const slope = finiteWingLiftSlope(i.aspectRatio)
  let { altitudeM, climbRateMps } = start
  let config = i.config
  let last = settingForCl(i.model, 0, config)
  let commandedRateMps = 0
  const n = Math.max(1, Math.ceil(dt / 0.02))
  const h = dt / n
  for (let k = 0; k < n; k++) {
    const q = 0.5 * isa(altitudeM).densityKgM3 * v * v
    commandedRateMps = Math.max(-i.rateMps, Math.min(i.rateMps, ALTITUDE_GAIN * (i.targetAltitudeM - altitudeM)))
    const accel = RATE_GAIN * (commandedRateMps - climbRateMps)
    const wingCl = i.massKg * (9.80665 + accel) / (q * i.wingAreaM2) + slope * climbRateMps / v
    // Levelled off on the target: no lift to gain or lose, so fly the cleanest setting that
    // carries the weight (slats and flaps retract, the angle rises a little); in the climb
    // or descent the configuration only changes when it has to.
    const level = Math.abs(i.targetAltitudeM - altitudeM) < LEVEL_BAND_M && Math.abs(climbRateMps) < 0.5
    last = settingForCl(i.model, sectionFromWing(wingCl, i.aspectRatio), config, level)
    config = last.setting.config
    const cl = sectionClFor(i.model, last.setting)!
    const lift = q * i.wingAreaM2 * (finiteWingLift(cl, i.aspectRatio) - slope * climbRateMps / v)
    climbRateMps += (lift / i.massKg - 9.80665) * h
    altitudeM += climbRateMps * h
    if (altitudeM <= 0) { altitudeM = 0; climbRateMps = Math.max(0, climbRateMps) }
  }
  return { state: { altitudeM, climbRateMps }, setting: last.setting, saturated: last.saturated, commandedRateMps }
}

export interface ClimbEstimate {
  /** Flight time from the start altitude until levelled off on the target (seconds), or null if it never gets there. */
  seconds: number | null
  /** Fastest vertical speed actually reached on the way (m/s, signed). */
  peakRateMps: number
  /** True when the wing ran out of lift (or of lift reduction) for the rate asked. */
  limited: boolean
}

/**
 * Fly the autopilot ahead of time (a quick dry run of the same controller) to find how
 * long the climb or descent takes and whether the wing can manage the chosen rate.
 */
export function estimateClimb(startAltitudeM: number, i: AutopilotInputs, maxSeconds = 3 * 3600): ClimbEstimate {
  let state: FlightState = { altitudeM: startAltitudeM, climbRateMps: 0 }
  let config = i.config
  let peak = 0; let limited = false
  for (let t = 0; t < maxSeconds; t += 2) {
    const r = flyAutopilot(state, { ...i, config }, 2)
    state = r.state; config = r.setting.config
    if (Math.abs(state.climbRateMps) > Math.abs(peak)) peak = state.climbRateMps
    if (r.saturated !== 0 && Math.abs(i.targetAltitudeM - state.altitudeM) > 50) limited = true
    // Out of lift and moving away from the target: it will never get there.
    if (limited && t > 120 && Math.sign(state.climbRateMps) !== Math.sign(i.targetAltitudeM - state.altitudeM)) return { seconds: null, peakRateMps: peak, limited }
    if (Math.abs(state.altitudeM - i.targetAltitudeM) < 1 && Math.abs(state.climbRateMps) < 0.05) return { seconds: t + 2, peakRateMps: peak, limited }
  }
  return { seconds: null, peakRateMps: peak, limited: true }
}
