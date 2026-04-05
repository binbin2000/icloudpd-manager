const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Request failed')
  }
  if (res.status === 204) return null
  return res.json()
}

// Jobs
export const api = {
  getJobs:      ()              => request('/jobs'),
  getJob:       (id)            => request(`/jobs/${id}`),
  createJob:    (data)          => request('/jobs', { method: 'POST', body: JSON.stringify(data) }),
  updateJob:    (id, data)      => request(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteJob:    (id)            => request(`/jobs/${id}`, { method: 'DELETE' }),
  runJob:       (id)            => request(`/jobs/${id}/run`, { method: 'POST' }),
  stopJob:      (id)            => request(`/jobs/${id}/stop`, { method: 'POST' }),
  getRuns:      (id)            => request(`/jobs/${id}/runs`),
  getLogs:      (runId)         => request(`/runs/${runId}/logs`),
  getStatus:    (runId)         => request(`/runs/${runId}/status`),
  send2FA:      (runId, code)   => request(`/runs/${runId}/2fa`, { method: 'POST', body: JSON.stringify({ code }) }),
  getStats:     ()              => request('/stats'),
  startListSession:   (username, password)   =>
    request('/icloud/list-session', { method: 'POST', body: JSON.stringify({ username, password }) }),
  getListSession:     (sessionId)            => request(`/icloud/sessions/${sessionId}`),
  send2FAToSession:   (sessionId, code)      =>
    request(`/icloud/sessions/${sessionId}/2fa`, { method: 'POST', body: JSON.stringify({ code }) }),
}

export function createLogStream(runId, onMessage, onDone) {
  const es = new EventSource(`/api/runs/${runId}/logs/stream`)
  es.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.__done__) {
      onDone?.(data.status)
      es.close()
    } else {
      onMessage(data)
    }
  }
  es.onerror = () => {
    onDone?.('error')
    es.close()
  }
  return () => es.close()
}
