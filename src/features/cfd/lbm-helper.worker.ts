/// <reference lib="webworker" />
import { runHelper, type HelperInit } from '../../physics/lbm/lbm-solver.ts'

// One band of the lattice: waits on shared memory for each step signal from the solver thread.
self.onmessage = (event: MessageEvent<HelperInit>) => runHelper(event.data)
