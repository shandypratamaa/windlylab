import type { ModelDefinition } from '../../types'

const model = (id: string, name: string, category: ModelDefinition['category'], kind: ModelDefinition['kind'], approximation: string, crossSection: ModelDefinition['metadata']['crossSection'], referenceAreaM2: number, characteristicLengthM: number, hasGround = false): ModelDefinition => ({
  id, name, category, kind,
  metadata: { approximation, crossSection, referenceAreaM2, characteristicLengthM, hasGround },
})

export const models: readonly ModelDefinition[] = [
  model('cube', 'Cube', 'Basic shapes', 'cube', 'Square cross-section', 'primitive', 1, 1),
  model('cylinder', 'Cylinder', 'Basic shapes', 'cylinder', 'Circular cylinder in cross-flow', 'primitive', 0.8, 1),
  model('sphere', 'Sphere', 'Basic shapes', 'sphere', 'Circular section through the centre (2D, so it behaves as a cylinder)', 'primitive', 0.8, 1),
  model('wedge', 'Wedge', 'Basic shapes', 'wedge', 'Triangular wedge, apex facing the wind', 'primitive', 0.7, 1),
  model('plate', 'Flat plate', 'Basic shapes', 'plate', 'Thin flat plate, 5% thick', 'primitive', 0.7, 1),
  model('suv', 'SUV', 'Cars', 'suv', 'Generic SUV side profile on a rolling road', 'vehicle', 2.8, 4.4, true),
  model('coupe', 'Coupe', 'Cars', 'coupe', 'Generic coupe side profile on a rolling road', 'vehicle', 2.1, 4.3, true),
  model('sports', 'Sports car', 'Cars', 'sports', 'Generic sports-car side profile on a rolling road', 'vehicle', 1.9, 4.2, true),
  model('spoiler', 'Sports car · spoiler', 'Cars', 'spoiler', 'Sports-car profile with a rear lip spoiler', 'vehicle', 2.0, 4.2, true),
  model('wing', 'Sports car · large wing', 'Cars', 'wing', 'Sports-car profile with a raised inverted rear wing', 'vehicle', 2.2, 4.2, true),
  model('race', 'Time-attack race car', 'Cars', 'race', 'Race-car profile with front splitter and large rear wing', 'vehicle', 2.5, 4.3, true),
  model('a350-wing', 'Airliner wing (slat + double flap)', 'Aircraft', 'aircraft-wing', 'Airliner wing section with a leading-edge slat and double-slotted flap', 'airfoil', 360, 3.8),
]

export const defaultModel = models[11]!
