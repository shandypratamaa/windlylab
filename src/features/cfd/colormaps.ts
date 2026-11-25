export type Rgb = [number, number, number]

function hex(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 256-entry RGB lookup table, linearly interpolated between evenly spaced stops. */
export function buildLut(stops: readonly string[]): Uint8ClampedArray {
  const colors = stops.map(hex)
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (colors.length - 1)
    const k = Math.min(colors.length - 2, Math.floor(t))
    const f = t - k
    const a = colors[k]!
    const b = colors[k + 1]!
    lut[i * 3] = a[0] + (b[0] - a[0]) * f
    lut[i * 3 + 1] = a[1] + (b[1] - a[1]) * f
    lut[i * 3 + 2] = a[2] + (b[2] - a[2]) * f
  }
  return lut
}

/** Speed: deep navy → teal → yellow → hot orange (perceptually ordered, readable on dark UI). */
export const speedStops = ['#0b1530', '#173a7a', '#1f78b4', '#1fb7c1', '#7fdc8a', '#e8e85a', '#f5a23a', '#e2412b'] as const
/** Diverging with a dark centre so quiescent flow recedes into the background. */
export const vorticityStops = ['#5fb3ff', '#2463c9', '#122c55', '#0b1012', '#561a1a', '#c63a2c', '#ff9a6b'] as const
/** Pressure coefficient: low pressure blue → ambient white → high pressure red (white sits exactly at Cp = 0). */
export const pressureStops = ['#08306b', '#2166ac', '#6aa7d8', '#ffffff', '#f4a582', '#d6604d', '#8b0a1a'] as const

export const speedLut = buildLut(speedStops)
export const vorticityLut = buildLut(vorticityStops)
export const pressureLut = buildLut(pressureStops)

export const cssGradient = (stops: readonly string[]) => `linear-gradient(90deg, ${stops.join(', ')})`
