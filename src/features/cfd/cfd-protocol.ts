import type { CfdParams, CfdStats, SmokeMode } from '../../physics/lbm/cfd-simulation.ts'
import type { ElementRole, Vec2 } from '../../physics/lbm/geometry.ts'

export type CfdCommand =
  | { type: 'configure'; params: CfdParams }
  | { type: 'running'; running: boolean }
  | { type: 'smoke'; mode: SmokeMode }
  | { type: 'reset' }
  | { type: 'add-emitter'; x: number; y: number }
  | { type: 'clear-emitters' }
  | { type: 'prefill-smoke' }
  | { type: 'frame-ack' }

export interface CfdGeometryMessage {
  type: 'geometry'
  version: number
  nx: number
  ny: number
  base: number
  polygons: Vec2[][]
  mask: Uint8Array
  bounds: { x0: number; x1: number; y0: number; y1: number }
  roles: ElementRole[]
  onGround: boolean
  /** Changes only when a different model or grid is loaded (used to re-frame the view). */
  shape: string
}

export interface CfdFrameMessage {
  type: 'frame'
  version: number
  ux: Float32Array
  uy: Float32Array
  rho: Float32Array
  particles: Float32Array
  /** Smoke concentration 0–255 per cell, empty unless realistic smoke is on. */
  dye: Uint8Array
  emitters: Vec2[]
  stats: CfdStats
  historyCd: Float32Array
  historyCl: Float32Array
  stepsPerSecond: number
}

export type CfdWorkerMessage = CfdGeometryMessage | CfdFrameMessage | { type: 'error'; message: string }
