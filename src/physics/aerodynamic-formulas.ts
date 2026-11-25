/** Dry-air atmosphere and flow-similarity formulas in SI units. Invalid inputs return NaN. */

const AIR_GAS_CONSTANT = 287.05287

export function airDensityIdealGas(pressurePa: number, temperatureC: number): number {
  const kelvin = temperatureC + 273.15
  return pressurePa > 0 && kelvin > 0 ? pressurePa / (AIR_GAS_CONSTANT * kelvin) : Number.NaN
}

/** Sutherland's law for air (μ₀ = 1.716e-5 Pa·s at 273.15 K, S = 110.4 K). */
export function airViscositySutherland(temperatureC: number): number {
  const t = temperatureC + 273.15
  return t > 0 ? 1.716e-5 * (t / 273.15) ** 1.5 * (273.15 + 110.4) / (t + 110.4) : Number.NaN
}

export function dynamicPressurePa(densityKgM3: number, speedMps: number): number {
  return Number.isFinite(densityKgM3) && densityKgM3 >= 0 && Number.isFinite(speedMps) && speedMps >= 0
    ? 0.5 * densityKgM3 * speedMps * speedMps
    : Number.NaN
}

export function reynoldsNumber(densityKgM3: number, speedMps: number, lengthM: number, viscosityPaS: number): number {
  return densityKgM3 >= 0 && speedMps >= 0 && lengthM > 0 && viscosityPaS > 0 && [densityKgM3, speedMps, lengthM, viscosityPaS].every(Number.isFinite)
    ? densityKgM3 * speedMps * lengthM / viscosityPaS
    : Number.NaN
}

/** Ideal-gas speed of sound with dry-air γ = 1.4. */
export function machNumber(speedMps: number, temperatureC: number): number {
  const temperatureK = temperatureC + 273.15
  return speedMps >= 0 && Number.isFinite(speedMps) && temperatureK > 0
    ? speedMps / Math.sqrt(1.4 * AIR_GAS_CONSTANT * temperatureK)
    : Number.NaN
}
