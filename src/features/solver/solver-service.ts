import type { SolverJob, SolverRequest, SolverService } from '../../types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `CFD API returned HTTP ${response.status}.`)
  return payload as T
}

export const solverService: SolverService = {
  submit(solverRequest: SolverRequest): Promise<SolverJob> {
    return request<SolverJob>('/api/solve', { method: 'POST', body: JSON.stringify(solverRequest) })
  },
  getJob(id: string): Promise<SolverJob> {
    return request<SolverJob>(`/api/jobs/${encodeURIComponent(id)}`)
  },
}
