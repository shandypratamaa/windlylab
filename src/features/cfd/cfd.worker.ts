/// <reference lib="webworker" />
import { CfdSimulation, type CfdParams, type SmokeMode } from '../../physics/lbm/cfd-simulation.ts'
import type { CfdCommand, CfdWorkerMessage } from './cfd-protocol.ts'

const scope = self as unknown as DedicatedWorkerGlobalScope
let sim: CfdSimulation | null = null
let running = true
let smoke: SmokeMode = 'particles'
let awaitingAck = false
let version = 0
/** Layout last sent to the renderer; the simulation swaps it while easing geometry. */
let sentLayout: unknown = null
let lastFrame = 0
let stepsSinceSample = 0
let sampleStart = performance.now()
let stepsPerSecond = 0
/** Milliseconds of solver work per scheduling slice. */
const SLICE_MS = 14

// With cross-origin isolation (SharedArrayBuffer), split the lattice over helper threads.
if (typeof SharedArrayBuffer !== 'undefined' && (self as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
  const spare = Math.max(0, (navigator.hardwareConcurrency || 4) - 2)
  const wanted = { low: 2, medium: 3, high: 4 } as const
  CfdSimulation.threads = {
    count: resolution => Math.min(spare, wanted[resolution]),
    spawn: () => new Worker(new URL('./lbm-helper.worker.ts', import.meta.url), { type: 'module' }),
  }
}

// setTimeout(0) is clamped to ~4 ms when nested; a message channel reschedules immediately.
const tick = new MessageChannel()
tick.port1.onmessage = () => loop()

function post(message: CfdWorkerMessage, transfer: Transferable[] = []) { scope.postMessage(message, transfer) }

function sendGeometry() {
  if (!sim) return
  version++
  sentLayout = sim.layout
  const { nx, ny, base, polygons, mask, bounds, roles } = sim.layout
  const copy = mask.slice()
  const shape = `${sim.params.kind}|${sim.params.airfoil}|${sim.params.resolution}`
  post({ type: 'geometry', version, nx, ny, base, polygons, mask: copy, bounds, roles, onGround: sim.body.onGround, shape }, [copy.buffer])
}

function sendFrame() {
  if (!sim) return
  // Geometry first, in the same tick, so the frame below always matches the drawn body.
  if (sim.layout !== sentLayout) sendGeometry()
  const { ux, uy, rho } = sim.solver
  const particles = smoke === 'particles' ? sim.particles() : new Float32Array(0)
  const dye = smoke === 'dye' ? sim.dyeBytes() : new Uint8Array(0)
  const history = sim.history(240)
  const frame = { ux: ux.slice(), uy: uy.slice(), rho: rho.slice() }
  post({ type: 'frame', version, ...frame, particles, dye, emitters: [...sim.emitterPoints], stats: sim.stats(), historyCd: history.cd, historyCl: history.cl, stepsPerSecond },
    [frame.ux.buffer, frame.uy.buffer, frame.rho.buffer, particles.buffer, dye.buffer, history.cd.buffer, history.cl.buffer])
  awaitingAck = true
  lastFrame = performance.now()
}

function configure(params: CfdParams) {
  if (!sim) sim = new CfdSimulation(params)
  else sim.configure(params)
  sendFrame()
}

function loop() {
  if (sim && running && !sim.solver.diverged) {
    const start = performance.now()
    while (performance.now() - start < SLICE_MS) {
      sim.advance(10, smoke)
      stepsSinceSample += 10
      if (sim.solver.diverged) break
    }
    const now = performance.now()
    if (now - sampleStart > 500) { stepsPerSecond = stepsSinceSample * 1000 / (now - sampleStart); stepsSinceSample = 0; sampleStart = now }
  }
  // Send a frame when the renderer has consumed the previous one (or as a fallback every 250 ms).
  if (sim && (!awaitingAck || performance.now() - lastFrame > 250)) sendFrame()
  if (running) tick.port2.postMessage(null)
  else setTimeout(loop, 50)
}

scope.onmessage = (event: MessageEvent<CfdCommand>) => {
  try {
    const command = event.data
    switch (command.type) {
      case 'configure': configure(command.params); break
      case 'running': running = command.running; break
      case 'smoke': smoke = command.mode; break
      case 'reset': sim?.reset(); break
      case 'add-emitter': sim?.addEmitter(command.x, command.y); break
      case 'clear-emitters': sim?.clearEmitters(); break
      case 'prefill-smoke': sim?.prefillSmoke(); break
      case 'frame-ack': awaitingAck = false; break
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

loop()
