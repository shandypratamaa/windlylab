import { useEffect, useRef, useState } from 'react'
import { Expand, Focus, ZoomIn, ZoomOut } from 'lucide-react'
import type { CfdParams, CfdStats, SmokeMode } from '../../physics/lbm/cfd-simulation.ts'
import { LATTICE_U } from '../../physics/lbm/cfd-simulation.ts'
import type { ElementRole, Vec2 } from '../../physics/lbm/geometry.ts'
import type { CfdCommand, CfdFrameMessage, CfdGeometryMessage, CfdWorkerMessage } from './cfd-protocol.ts'
import { pressureLut, speedLut, vorticityLut } from './colormaps.ts'

export type CfdDisplay = 'smoke' | 'velocity' | 'vorticity' | 'pressure'

export interface CfdTelemetry {
  stats: CfdStats
  historyCd: Float32Array
  historyCl: Float32Array
  stepsPerSecond: number
  grid: { nx: number; ny: number }
}

interface Props {
  params: CfdParams
  running: boolean
  smoke: SmokeMode
  display: CfdDisplay
  airspeedMps: number
  resetKey: number
  clearEmittersKey: number
  onTelemetry: (telemetry: CfdTelemetry) => void
  onError?: (message: string) => void
}

interface Probe { left: number; top: number; speed: number; cp: number; angle: number }
/** Visible window in lattice units: left edge, bottom edge, and width (height follows the canvas aspect). */
interface ViewWindow { x0: number; y0: number; w: number }

/** Frames the model with room for its wake; cars keep the road at the bottom. */
function focusWindow(g: CfdGeometryMessage, aspect: number): ViewWindow {
  const length = g.bounds.x1 - g.bounds.x0
  const height = g.bounds.y1 - g.bounds.y0
  const w = Math.min(g.nx, Math.max(g.onGround ? 5 * length : 10 * length, 8 * height / Math.max(aspect, 0.2), 120))
  const x0 = Math.max(0, Math.min(g.nx - w, g.bounds.x0 - (g.onGround ? 0.12 : 0.18) * w))
  const h = w * aspect
  const y0 = g.onGround ? 0 : (g.bounds.y0 + g.bounds.y1) / 2 - h / 2
  return clampWindow({ x0, y0, w }, g, aspect)
}

function wholeTunnel(g: CfdGeometryMessage, aspect: number): ViewWindow {
  const w = Math.max(g.nx, g.ny / aspect)
  return { x0: (g.nx - w) / 2, y0: (g.ny - w * aspect) / 2, w }
}

/** Keeps the window inside the tunnel where possible, centring it when it is larger. */
function clampWindow(v: ViewWindow, g: CfdGeometryMessage, aspect: number): ViewWindow {
  const max = Math.max(g.nx, g.ny / aspect)
  const w = Math.min(max, Math.max(24, v.w))
  const h = w * aspect
  const x0 = w >= g.nx ? (g.nx - w) / 2 : Math.min(g.nx - w, Math.max(0, v.x0))
  const y0 = h >= g.ny ? (g.ny - h) / 2 : Math.min(g.ny - h, Math.max(0, v.y0))
  return { x0, y0, w }
}

export default function CfdView({ params, running, smoke, display, airspeedMps, resetKey, clearEmittersKey, onTelemetry, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const geometryRef = useRef<CfdGeometryMessage | null>(null)
  const frameRef = useRef<CfdFrameMessage | null>(null)
  const dirtyRef = useRef(false)
  const viewRef = useRef({ display, smoke, airspeedMps })
  const telemetryRef = useRef(onTelemetry)
  const errorRef = useRef(onError)
  const layoutRef = useRef({ scale: 1, x0: 0, top: 0, aspect: 0.5 })
  const windowRef = useRef<ViewWindow | null>(null)
  const shapeRef = useRef('')
  /** Tween of the drawn body between solver geometry updates (which arrive ~15–25×/s). */
  const tweenRef = useRef<{ from: Vec2[][] | null; start: number; duration: number; lastArrival: number; shown: Vec2[][] | null }>({ from: null, start: 0, duration: 60, lastArrival: 0, shown: null })
  const dragRef = useRef<{ x: number; y: number; start: ViewWindow; moved: boolean; id: number } | null>(null)
  const hoverRef = useRef<{ x: number; y: number } | null>(null)
  const [probe, setProbe] = useState<Probe | null>(null)
  viewRef.current = { display, smoke, airspeedMps }
  telemetryRef.current = onTelemetry
  errorRef.current = onError

  const send = (command: CfdCommand) => workerRef.current?.postMessage(command)

  useEffect(() => {
    const worker = new Worker(new URL('./cfd.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    let lastTelemetry = 0
    worker.onmessage = (event: MessageEvent<CfdWorkerMessage>) => {
      const message = event.data
      if (message.type === 'geometry') {
        const tween = tweenRef.current
        const now = performance.now()
        const previous = geometryRef.current
        const sameShape = previous && previous.shape === message.shape && tween.shown && tween.shown.length === message.polygons.length
          && tween.shown.every((poly, i) => poly.length === message.polygons[i]!.length)
        // Glide from what is on screen now to the new body over about one update interval.
        tween.from = sameShape ? tween.shown : null
        tween.duration = Math.min(150, Math.max(30, now - tween.lastArrival))
        tween.start = now
        tween.lastArrival = now
        geometryRef.current = message
        // Re-frame only when a different model or grid loads; angle and scale changes keep your zoom.
        if (message.shape !== shapeRef.current) { shapeRef.current = message.shape; windowRef.current = null }
        dirtyRef.current = true
        return
      }
      if (message.type === 'error') { errorRef.current?.(message.message); return }
      frameRef.current = message
      dirtyRef.current = true
      const now = performance.now()
      const geometry = geometryRef.current
      if (geometry && now - lastTelemetry > 200) {
        lastTelemetry = now
        telemetryRef.current({ stats: message.stats, historyCd: message.historyCd, historyCl: message.historyCl, stepsPerSecond: message.stepsPerSecond, grid: { nx: geometry.nx, ny: geometry.ny } })
      }
    }
    worker.onerror = event => errorRef.current?.(event.message || 'The CFD worker failed to start.')
    return () => { worker.terminate(); workerRef.current = null }
  }, [])

  const paramsKey = JSON.stringify(params)
  useEffect(() => { send({ type: 'configure', params }) }, [paramsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { send({ type: 'running', running }) }, [running])
  useEffect(() => { send({ type: 'smoke', mode: smoke }) }, [smoke])
  useEffect(() => { if (resetKey) send({ type: 'reset' }) }, [resetKey])
  useEffect(() => { if (clearEmittersKey) send({ type: 'clear-emitters' }) }, [clearEmittersKey])
  useEffect(() => { dirtyRef.current = true }, [display, smoke])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const field = document.createElement('canvas')
    const fieldCtx = field.getContext('2d')!
    let image: ImageData | null = null
    let raf = 0
    let cssW = 0
    let cssH = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      cssW = rect.width; cssH = rect.height
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      dirtyRef.current = true
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const geometry = geometryRef.current
      const frame = frameRef.current
      if (!dirtyRef.current || !geometry || !frame || frame.version !== geometry.version) return
      dirtyRef.current = false
      const { nx, ny, mask } = geometry
      if (field.width !== nx || field.height !== ny || !image) {
        field.width = nx; field.height = ny
        image = fieldCtx.createImageData(nx, ny)
      }
      paintField(image.data, frame, mask, nx, ny, viewRef.current.display, viewRef.current.smoke === 'dye')
      fieldCtx.putImageData(image, 0, 0)

      const aspect = cssH / Math.max(1, cssW)
      const view = windowRef.current = clampWindow(windowRef.current ?? focusWindow(geometry, aspect), geometry, aspect)
      const scale = cssW / view.w
      const top = view.y0 + view.w * aspect
      layoutRef.current = { scale, x0: view.x0, top, aspect }
      ctx.fillStyle = '#080b0d'
      ctx.fillRect(0, 0, cssW, cssH)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      // Crop the field image to the visible window.
      const sx0 = Math.max(0, view.x0); const sx1 = Math.min(nx, view.x0 + view.w)
      const sy0 = Math.max(0, view.y0); const sy1 = Math.min(ny, top)
      if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(field, sx0, ny - sy1, sx1 - sx0, sy1 - sy0, (sx0 - view.x0) * scale, (top - sy1) * scale, (sx1 - sx0) * scale, (sy1 - sy0) * scale)

      const toX = (x: number) => (x - view.x0) * scale
      const toY = (y: number) => (top - y) * scale
      const ox = toX(0); const oy = toY(ny)
      if (viewRef.current.smoke === 'particles' && frame.particles.length) drawSmoke(ctx, frame.particles, toX, toY, scale, viewRef.current.display, nx)
      const tween = tweenRef.current
      const progress = tween.from ? Math.min(1, (performance.now() - tween.start) / tween.duration) : 1
      const polygons = progress < 1 && tween.from
        ? geometry.polygons.map((poly, i) => poly.map(([x, y], k) => { const [fx, fy] = tween.from![i]![k]!; return [fx + (x - fx) * progress, fy + (y - fy) * progress] as Vec2 }))
        : geometry.polygons
      tween.shown = polygons
      if (progress < 1) dirtyRef.current = true
      drawBody(ctx, polygons, geometry.roles, toX, toY)
      drawEmitters(ctx, frame.emitters, toX, toY)
      drawGround(ctx, geometry, toX, toY, nx)
      // Tunnel outline so the solved domain reads clearly against the letterbox.
      ctx.strokeStyle = '#1d2a2d'
      ctx.lineWidth = 1
      ctx.strokeRect(ox + 0.5, oy + 0.5, nx * scale - 1, ny * scale - 1)
      workerRef.current?.postMessage({ type: 'frame-ack' } satisfies CfdCommand)
      const hover = hoverRef.current
      if (hover) updateProbe(hover.x, hover.y)
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); observer.disconnect() }
  }, [])

  const latticePoint = (clientX: number, clientY: number): [number, number, number, number] | null => {
    const canvas = canvasRef.current
    const geometry = geometryRef.current
    if (!canvas || !geometry) return null
    const rect = canvas.getBoundingClientRect()
    const left = clientX - rect.left
    const top = clientY - rect.top
    const view = layoutRef.current
    const x = view.x0 + left / view.scale
    const y = view.top - top / view.scale
    if (x < 0 || y < 0 || x >= geometry.nx || y >= geometry.ny) return null
    return [x, y, left, top]
  }

  const updateProbe = (clientX: number, clientY: number) => {
    const point = latticePoint(clientX, clientY)
    const frame = frameRef.current
    const geometry = geometryRef.current
    if (!point || !frame || !geometry) { setProbe(null); return }
    const [x, y, left, top] = point
    const i = Math.floor(y) * geometry.nx + Math.floor(x)
    if (geometry.mask[i]) { setProbe(null); return }
    const u = frame.ux[i]!; const v = frame.uy[i]!
    const cp = (frame.rho[i]! - 1) / 3 / (0.5 * LATTICE_U * LATTICE_U)
    setProbe({ left, top, speed: Math.hypot(u, v) / LATTICE_U * viewRef.current.airspeedMps, cp, angle: Math.atan2(v, u) * 180 / Math.PI })
  }

  const setWindow = (make: (g: CfdGeometryMessage, current: ViewWindow, aspect: number) => ViewWindow) => {
    const g = geometryRef.current
    if (!g) return
    const aspect = layoutRef.current.aspect
    windowRef.current = clampWindow(make(g, windowRef.current ?? focusWindow(g, aspect), aspect), g, aspect)
    dirtyRef.current = true
  }
  /** Zoom by `factor` (>1 zooms in) about a canvas point given as fractions of width/height. */
  const zoomAt = (factor: number, fx = 0.5, fy = 0.5) => setWindow((_, v, aspect) => {
    const w = v.w / factor
    const px = v.x0 + fx * v.w; const py = v.y0 + (1 - fy) * v.w * aspect
    return { x0: px - fx * w, y0: py - (1 - fy) * w * aspect, w }
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Non-passive so the page does not scroll while zooming the tunnel.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomAt(Math.exp(-event.deltaY * 0.0015), (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="cfd-view">
    <canvas ref={canvasRef} className="cfd-canvas"
      onPointerDown={event => {
        if (event.button !== 0 || !windowRef.current) return
        dragRef.current = { x: event.clientX, y: event.clientY, start: windowRef.current, moved: false, id: event.pointerId }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const drag = dragRef.current
        if (drag && drag.id === event.pointerId) {
          const dx = event.clientX - drag.x; const dy = event.clientY - drag.y
          if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true
          if (drag.moved) {
            const scale = layoutRef.current.scale
            setWindow(() => ({ x0: drag.start.x0 - dx / scale, y0: drag.start.y0 + dy / scale, w: drag.start.w }))
            setProbe(null)
            return
          }
        }
        hoverRef.current = { x: event.clientX, y: event.clientY }; updateProbe(event.clientX, event.clientY)
      }}
      onPointerUp={event => {
        const drag = dragRef.current
        dragRef.current = null
        if (drag && !drag.moved) { const p = latticePoint(event.clientX, event.clientY); if (p) send({ type: 'add-emitter', x: p[0], y: p[1] }) }
      }}
      onPointerCancel={() => { dragRef.current = null }}
      onPointerLeave={() => { hoverRef.current = null; setProbe(null) }}
      style={{ cursor: 'crosshair' }}
      aria-label="Wind tunnel flow. Click to add smoke, drag to pan, scroll to zoom." role="img" />
    <div className="cfd-zoom" role="toolbar" aria-label="Tunnel view">
      <button type="button" className="icon-button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(1.4)}><ZoomIn size={15} /></button>
      <button type="button" className="icon-button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.4)}><ZoomOut size={15} /></button>
      <button type="button" className="icon-button" title="Focus on the model" aria-label="Focus on the model" onClick={() => setWindow((g, _v, aspect) => focusWindow(g, aspect))}><Focus size={15} /></button>
      <button type="button" className="icon-button" title="Show the whole tunnel" aria-label="Show the whole tunnel" onClick={() => setWindow((g, _v, aspect) => wholeTunnel(g, aspect))}><Expand size={15} /></button>
    </div>
    {probe && <div className="cfd-probe" style={{ left: probe.left + 14, top: probe.top + 14 }}>
      <span>|U| <b>{probe.speed.toFixed(1)} m/s</b></span>
      <span>Cp <b>{probe.cp.toFixed(2)}</b></span>
      <span>θ <b>{probe.angle.toFixed(0)}°</b></span>
    </div>}
  </div>
}

function paintField(data: Uint8ClampedArray, frame: CfdFrameMessage, mask: Uint8Array, nx: number, ny: number, display: CfdDisplay, showDye: boolean) {
  const { ux, uy, rho } = frame
  const dye = showDye && frame.dye.length === nx * ny ? frame.dye : null
  const u0 = LATTICE_U
  const cpScale = 1 / (3 * 0.5 * u0 * u0)
  for (let y = 0; y < ny; y++) {
    const row = (ny - 1 - y) * nx
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x
      const o = (row + x) * 4
      // Solid cells take the tunnel background: only the smooth outline drawn on top shows the
      // body, so its stair-stepped cell edges never show.
      if (mask[i]) { data[o] = 11; data[o + 1] = 16; data[o + 2] = 19; data[o + 3] = 255; continue }
      let r = 11; let g = 16; let b = 19
      if (display === 'velocity') {
        const t = Math.min(255, Math.max(0, Math.round(Math.hypot(ux[i]!, uy[i]!) / (1.6 * u0) * 255))) * 3
        r = speedLut[t]!; g = speedLut[t + 1]!; b = speedLut[t + 2]!
      } else if (display === 'vorticity' || display === 'smoke') {
        const xl = x > 0 ? i - 1 : i; const xr = x < nx - 1 ? i + 1 : i
        const yd = y > 0 ? i - nx : i; const yu = y < ny - 1 ? i + nx : i
        const w = ((uy[xr]! - uy[xl]!) / (xr - xl || 1) - (ux[yu]! - ux[yd]!) / ((yu - yd) / nx || 1))
        if (display === 'vorticity') {
          const t = Math.min(255, Math.max(0, Math.round(128 + w / u0 * 9 * 127))) * 3
          r = vorticityLut[t]!; g = vorticityLut[t + 1]!; b = vorticityLut[t + 2]!
        } else if (!dye) {
          // Smoke backdrop: near-black with a faint hint of vorticity so wakes read without stealing focus.
          const a = Math.min(1, Math.abs(w) / u0 * 4)
          const warm = w < 0 ? 1 : 0
          r = 10 + a * (warm ? 22 : 6); g = 14 + a * 10; b = 17 + a * (warm ? 6 : 24)
        } else {
          // Realistic smoke: matte black tunnel lit from above, like a photographed smoke tunnel.
          const shade = 1 - (y / ny) * 0.35
          r = 7 * shade; g = 9 * shade; b = 11 * shade
        }
      } else {
        const cp = (rho[i]! - 1) * cpScale
        const t = Math.round(cp < 0 ? 128 + Math.max(-1, cp / 2) * 128 : 128 + Math.min(1, cp) * 127) * 3
        r = pressureLut[t]!; g = pressureLut[t + 1]!; b = pressureLut[t + 2]!
      }
      if (dye) {
        // Optical density: thin streams look wispy, dense ones saturate to bright white.
        const c = dye[i]! / 255
        const a = (1 - Math.exp(-3.2 * c)) * (display === 'smoke' ? 1 : 0.7)
        // Over the white-centred pressure map, smoke is drawn dark so it stays visible.
        const [sr, sg, sb] = display === 'pressure' ? [28, 34, 38] : [236, 240, 238]
        r += (sr - r) * a; g += (sg - g) * a; b += (sb - b) * a
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255
    }
  }
}

/**
 * Streaklines: each smoke wand's particles (in release order) are joined into one
 * smooth curve through their midpoints. A line breaks where neighbouring particles have
 * been torn apart (in a wake or a stall), so separated flow still reads as broken smoke.
 * Older smoke fades, as before.
 */
function drawSmoke(ctx: CanvasRenderingContext2D, particles: Float32Array, toX: (x: number) => number, toY: (y: number) => number, scale: number, display: CfdDisplay, nx: number) {
  const lifetime = nx / LATTICE_U
  const buckets = [0.95, 0.72, 0.5, 0.32]
  const base = display === 'smoke' ? 1 : 0.55
  /** Largest gap (cells) still drawn as one continuous line. */
  const maxGap = 3.2
  const bucketOf = (p: number) => { const age = particles[p + 2]! / lifetime; return age < 0.35 ? 0 : age < 0.7 ? 1 : age < 1.1 ? 2 : 3 }
  ctx.save()
  ctx.lineWidth = Math.max(1, Math.min(2.2, scale * 0.42))
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let bucket = 0; bucket < buckets.length; bucket++) {
    ctx.beginPath()
    // Walk runs of consecutive particles from the same wand, in this age band, close enough to join.
    let run: number[] = []
    const flush = () => {
      if (run.length >= 2) {
        const X = (k: number) => toX(particles[run[k]!]!); const Y = (k: number) => toY(particles[run[k]! + 1]!)
        ctx.moveTo(X(0), Y(0))
        for (let k = 1; k < run.length - 1; k++) ctx.quadraticCurveTo(X(k), Y(k), (X(k) + X(k + 1)) / 2, (Y(k) + Y(k + 1)) / 2)
        ctx.lineTo(X(run.length - 1), Y(run.length - 1))
      } else if (run.length === 1) {
        const x = toX(particles[run[0]!]!); const y = toY(particles[run[0]! + 1]!)
        ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y)
      }
      run = []
    }
    for (let p = 0; p < particles.length; p += 4) {
      if (bucketOf(p) !== bucket) { flush(); continue }
      if (run.length) {
        const q = run[run.length - 1]!
        const gap = Math.hypot(particles[p]! - particles[q]!, particles[p + 1]! - particles[q + 1]!)
        if (particles[p + 3] !== particles[q + 3] || gap > maxGap) flush()
      }
      run.push(p)
    }
    flush()
    ctx.strokeStyle = display === 'pressure' ? `rgba(20, 26, 30, ${buckets[bucket]! * 0.8})` : `rgba(232, 244, 241, ${buckets[bucket]! * base * 0.85})`
    ctx.stroke()
  }
  ctx.restore()
}

/** Element colours follow the usual high-lift diagram convention: slat blue, flaps red. */
const ROLE_FILL: Record<ElementRole, string> = { main: '#c3ccce', slat: '#4a78e8', flap: '#e0574a' }

function drawBody(ctx: CanvasRenderingContext2D, polygons: Vec2[][], roles: ElementRole[], toX: (x: number) => number, toY: (y: number) => number) {
  ctx.save()
  ctx.lineJoin = 'round'
  for (let p = 0; p < polygons.length; p++) {
    const poly = polygons[p]!
    ctx.beginPath()
    poly.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(toX(x), toY(y)); else ctx.lineTo(toX(x), toY(y)) })
    ctx.closePath()
    ctx.fillStyle = ROLE_FILL[roles[p] ?? 'main']
    ctx.fill()
    ctx.strokeStyle = '#eef4f3'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  ctx.restore()
}

function drawEmitters(ctx: CanvasRenderingContext2D, emitters: Vec2[], toX: (x: number) => number, toY: (y: number) => number) {
  ctx.save()
  for (const [x, y] of emitters) {
    ctx.beginPath()
    ctx.arc(toX(x), toY(y), 4, 0, Math.PI * 2)
    ctx.fillStyle = '#58d5c7'
    ctx.fill()
    ctx.strokeStyle = '#0b1012'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.restore()
}

function drawGround(ctx: CanvasRenderingContext2D, geometry: CfdGeometryMessage, toX: (x: number) => number, toY: (y: number) => number, nx: number) {
  // Only vehicle layouts touch the floor; free bodies float mid-tunnel.
  const minY = Math.min(...geometry.polygons.flat().map(p => p[1]))
  if (minY > geometry.base * 0.2) return
  ctx.save()
  ctx.strokeStyle = '#58d5c7'
  ctx.globalAlpha = 0.7
  ctx.setLineDash([6, 5])
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(toX(0), toY(0) - 1)
  ctx.lineTo(toX(nx), toY(0) - 1)
  ctx.stroke()
  ctx.restore()
}
