import { useEffect, useRef } from 'react'
import type { SolverFlowField } from '../../types'

export default function SolverFieldPreview({ field, quantity }: { field: SolverFlowField; quantity: 'velocity' | 'pressure' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const { statistics, samples } = field
    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.fillStyle = '#0a0f10'
      context.fillRect(0, 0, rect.width, rect.height)
      const pad = 12
      const width = rect.width - pad * 2
      const height = rect.height - pad * 2
      const extentX = statistics.xMaxM - statistics.xMinM || 1
      const extentY = statistics.yMaxM - statistics.yMinM || 1
      const min = quantity === 'velocity' ? statistics.speedMinMps : statistics.pressureMinPa
      const max = quantity === 'velocity' ? statistics.speedMaxMps : statistics.pressureMaxPa
      const range = max - min || 1
      const radius = Math.max(1.4, Math.min(3, Math.sqrt((width * height) / samples.length) * 0.72))
      for (const sample of samples) {
        const value = quantity === 'velocity' ? sample.speedMps : sample.pressurePa
        const t = Math.max(0, Math.min(1, (value - min) / range))
        const x = pad + ((sample.xM - statistics.xMinM) / extentX) * width
        const y = rect.height - pad - ((sample.yM - statistics.yMinM) / extentY) * height
        context.beginPath()
        context.arc(x, y, radius, 0, Math.PI * 2)
        context.fillStyle = quantity === 'velocity'
          ? `rgb(${Math.round(47 + 180 * t)}, ${Math.round(110 + 105 * (1 - Math.abs(0.5 - t) * 2))}, ${Math.round(190 - 135 * t)})`
          : `rgb(${Math.round(40 + 210 * t)}, ${Math.round(105 + 105 * (1 - Math.abs(0.5 - t) * 2))}, ${Math.round(190 - 150 * t)})`
        context.fill()
      }
      // NACA 0012 outline is shown for orientation; all colored values are the sampled solver field.
      context.beginPath()
      for (let i = 0; i <= 64; i += 1) {
        const theta = (Math.PI * i) / 64
        const xChord = (1 - Math.cos(theta)) / 2
        const thickness = 0.6 * 0.12 * (0.2969 * Math.sqrt(xChord) - 0.1260 * xChord - 0.3516 * xChord ** 2 + 0.2843 * xChord ** 3 - 0.1015 * xChord ** 4)
        const px = pad + ((xChord - statistics.xMinM) / extentX) * width
        const py = rect.height - pad - ((thickness - statistics.yMinM) / extentY) * height
        if (i === 0) context.moveTo(px, py)
        else context.lineTo(px, py)
      }
      for (let i = 64; i >= 0; i -= 1) {
        const theta = (Math.PI * i) / 64
        const xChord = (1 - Math.cos(theta)) / 2
        const thickness = -0.6 * 0.12 * (0.2969 * Math.sqrt(xChord) - 0.1260 * xChord - 0.3516 * xChord ** 2 + 0.2843 * xChord ** 3 - 0.1015 * xChord ** 4)
        const px = pad + ((xChord - statistics.xMinM) / extentX) * width
        const py = rect.height - pad - ((thickness - statistics.yMinM) / extentY) * height
        context.lineTo(px, py)
      }
      context.closePath()
      context.fillStyle = '#dbe7e4'
      context.strokeStyle = '#f4fbf9'
      context.lineWidth = 1
      context.fill()
      context.stroke()
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [field, quantity])

  return <canvas className="solver-field-canvas" ref={canvasRef} role="img" aria-label={`OpenFOAM NACA 0012 ${quantity} field, sampled from solver cell values`} />
}
