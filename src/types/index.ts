export type ModelCategory = 'Basic shapes' | 'Cars' | 'Aircraft'
export type ModelKind = 'cube' | 'cylinder' | 'sphere' | 'wedge' | 'plate' | 'suv' | 'coupe' | 'sports' | 'spoiler' | 'wing' | 'race' | 'aircraft-wing'
export type SolverStatus = 'Not configured' | 'Ready' | 'Queued' | 'Running' | 'Completed' | 'Failed'

export interface GeometryMetadata {
  readonly approximation: string
  readonly hasGround: boolean
  readonly referenceAreaM2: number
  readonly characteristicLengthM: number
  readonly crossSection: 'airfoil' | 'vehicle' | 'primitive'
}
export interface ModelDefinition {
  readonly id: string
  readonly name: string
  readonly category: ModelCategory
  readonly kind: ModelKind
  readonly metadata: GeometryMetadata
}
export interface WindConditions {
  airspeedMps: number
  temperatureC: number
  pressurePa: number
  characteristicLengthM: number
}
export interface ExperimentSettings {
  angleOfAttackDeg: number
  modelScale: number
  wind: WindConditions
}
export interface AerodynamicResults {
  dragN?: number
  liftN?: number
  dragCoefficient?: number
  liftCoefficient?: number
  reynoldsNumber?: number
  referenceAreaM2?: number
  source: 'unavailable' | 'openfoam' | 'validated-solver' | 'documented-estimate'
}
export interface SolverRequest { angleOfAttackDeg: number; airspeedMps: number; densityKgM3: number; dynamicViscosityPaS: number }
export interface SolverFieldSample { xM: number; yM: number; uxMps: number; uyMps: number; speedMps: number; pressurePa: number }
export interface SolverFlowField { samples: SolverFieldSample[]; statistics: { xMinM: number; xMaxM: number; yMinM: number; yMaxM: number; cellCount: number; sampleCount: number; speedMinMps: number; speedMaxMps: number; pressureMinPa: number; pressureMaxPa: number; timeDirectory: string }; pressureMeaning: string; velocityMeaning: string }
export interface SolverJob { id: string; status: SolverStatus; message?: string; error?: string; convergenceMessage?: string; parameters?: Record<string, string | number>; results?: AerodynamicResults; convergenceHistory?: number[]; flowField?: SolverFlowField }
export interface SolverService { submit(request: SolverRequest): Promise<SolverJob>; getJob(id: string): Promise<SolverJob> }
