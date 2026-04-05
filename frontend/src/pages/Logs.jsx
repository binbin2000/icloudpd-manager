import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, createLogStream } from '../api'
import { ArrowLeft, Download, AlertTriangle, Loader2 } from 'lucide-react'

const LEVEL_CLASS = {
  info:    'log-info',
  success: 'log-success',
  warning: 'log-warning',
  error:   'log-error',
}

function LogLine({ log }) {
  const cls = LEVEL_CLASS[log.level] ?? 'log-info'
  const ts = new Date(log.timestamp).toLocaleTimeString()
  return (
    <div className={`${cls} flex gap-3`}>
      <span className="text-gray-600 shrink-0 select-none w-20">{ts}</span>
      <span className={`uppercase shrink-0 w-10 font-bold text-[10px] pt-0.5 ${cls}`}>
        {log.level.slice(0, 4)}
      </span>
      <span className="break-all">{log.message}</span>
    </div>
  )
}

export default function Logs() {
  const { id: jobId, runId } = useParams()
  const navigate = useNavigate()
  const bottomRef = useRef(null)
  const [logs, setLogs] = useState([])
  const [done, setDone] = useState(false)
  const [finalStatus, setFinalStatus] = useState(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const { data: run } = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.getStatus(runId),
    refetchInterval: done ? false : 2000,
  })

  const { data: job } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.getJob(jobId),
  })

  // Stream logs via SSE
  useEffect(() => {
    setLogs([])
    setDone(false)
    const unsub = createLogStream(
      runId,
      (log) => setLogs(prev => [...prev, log]),
      (status) => { setDone(true); setFinalStatus(status) },
    )
    return unsub
  }, [runId])

  // Auto scroll to bottom
  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const downloadLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] ${l.level.toUpperCase()} ${l.message}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `sync-${runId.slice(0, 8)}.log`
    a.click()
  }

  const statusColors = { success: 'badge-green', error: 'badge-red', running: 'badge-blue', stopped: 'badge-gray' }

  return (
    <div className="p-6 max-w-5xl mx-auto flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate(`/jobs`)} className="btn-secondary btn-sm">
          <ArrowLeft className="w-3 h-3" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900">
            {job?.name ?? 'Sync Job'} — Logs
          </h1>
          <p className="text-xs text-gray-400 font-mono mt-0.5">Run: {runId}</p>
        </div>
        <div className="flex items-center gap-2">
          {run && (
            <span className={statusColors[run.status] ?? 'badge-gray'}>
              {run.status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
              {run.status}
            </span>
          )}
          {run?.needs_2fa && (
            <span className="badge-yellow">
              <AlertTriangle className="w-3 h-3" /> Needs 2FA
            </span>
          )}
          <button className="btn-secondary btn-sm" onClick={downloadLogs}>
            <Download className="w-3 h-3" /> Download
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4 mb-2">
        <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            className="rounded"
          />
          Auto-scroll
        </label>
        <span className="text-xs text-gray-400">{logs.length} lines</span>
        {done && finalStatus && (
          <span className={`ml-auto text-xs font-medium ${finalStatus === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
            Finished: {finalStatus}
          </span>
        )}
      </div>

      {/* Terminal */}
      <div
        className="flex-1 bg-gray-900 rounded-xl overflow-auto p-4 log-terminal min-h-[400px]"
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          setAutoScroll(atBottom)
        }}
      >
        {logs.length === 0 && !done ? (
          <div className="text-gray-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Waiting for output…
          </div>
        ) : (
          logs.map(log => <LogLine key={log.id} log={log} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* 2FA prompt */}
      {run?.needs_2fa && (
        <TwoFAInline runId={runId} />
      )}
    </div>
  )
}

function TwoFAInline({ runId }) {
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const submit = async () => {
    setSending(true)
    try {
      await api.send2FA(runId, code)
      setSent(true)
    } finally {
      setSending(false)
    }
  }

  if (sent) return null

  return (
    <div className="mt-3 card p-4 border-yellow-300 bg-yellow-50 flex items-center gap-3">
      <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-yellow-800">2FA code required</p>
        <p className="text-xs text-yellow-600">Check your Apple device for a 6-digit code</p>
      </div>
      <input
        className="input w-32 text-center font-mono"
        placeholder="000000"
        value={code}
        onChange={e => setCode(e.target.value)}
        maxLength={8}
        autoFocus
      />
      <button
        className="btn-primary btn-sm"
        onClick={submit}
        disabled={!code || sending}
      >
        {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Submit'}
      </button>
    </div>
  )
}
