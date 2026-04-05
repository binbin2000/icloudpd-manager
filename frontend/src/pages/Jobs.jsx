import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import {
  Play, Square, Trash2, Edit, Plus, RefreshCw,
  CheckCircle2, XCircle, Clock, Loader2, AlertTriangle,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const STATUS_BADGE = {
  success: <span className="badge-green"><CheckCircle2 className="w-3 h-3"/>success</span>,
  error:   <span className="badge-red"><XCircle className="w-3 h-3"/>error</span>,
  running: <span className="badge-blue"><Loader2 className="w-3 h-3 animate-spin"/>running</span>,
  stopped: <span className="badge-gray"><Square className="w-3 h-3"/>stopped</span>,
}

function TwoFAModal({ job, onClose }) {
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const qc = useQueryClient()

  const submit = async () => {
    if (!job.run_id) return
    setSending(true)
    try {
      await api.send2FA(job.run_id, code)
      qc.invalidateQueries(['jobs'])
      onClose()
    } catch (e) {
      alert(e.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="card p-6 w-full max-w-sm space-y-4 shadow-xl">
        <div className="flex items-center gap-2 text-yellow-600">
          <AlertTriangle className="w-5 h-5" />
          <h2 className="font-semibold text-gray-900">Two-Factor Authentication</h2>
        </div>
        <p className="text-sm text-gray-600">
          iCloud sent a verification code to your trusted Apple device.
          Enter the code below to continue syncing <strong>{job.name}</strong>.
        </p>
        <input
          className="input text-center text-xl tracking-widest font-mono"
          placeholder="000000"
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
          maxLength={8}
          onKeyDown={e => e.key === 'Enter' && submit()}
          autoFocus
        />
        <div className="flex gap-2 justify-end">
          <button className="btn-secondary btn-sm" onClick={onClose}>Dismiss</button>
          <button
            className="btn-primary btn-sm"
            onClick={submit}
            disabled={!code || sending}
          >
            {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Submit Code
          </button>
        </div>
      </div>
    </div>
  )
}

function JobCard({ job, onDelete, onNeed2FA }) {
  const qc = useQueryClient()
  const navigate = useNavigate()

  // Surface the 2FA need to the parent via callback
  const [prev2FA, setPrev2FA] = useState(false)
  useEffect(() => {
    if (job.needs_2fa && !prev2FA) onNeed2FA?.(job)
    setPrev2FA(job.needs_2fa)
  }, [job.needs_2fa])

  const runMutation = useMutation({
    mutationFn: () => api.runJob(job.id),
    onSuccess: () => qc.invalidateQueries(['jobs']),
  })

  const stopMutation = useMutation({
    mutationFn: () => api.stopJob(job.id),
    onSuccess: () => qc.invalidateQueries(['jobs']),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteJob(job.id),
    onSuccess: () => { qc.invalidateQueries(['jobs']); onDelete?.() },
  })

  const runsQuery = useQuery({
    queryKey: ['runs', job.id],
    queryFn: () => api.getRuns(job.id),
    enabled: false,
  })

  const lastStatus = job.last_run_status
  const isRunning  = job.is_running

  return (
    <>
      <div className="card p-5 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold text-gray-900 text-base">{job.name}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{job.username}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
            {isRunning
              ? STATUS_BADGE.running
              : lastStatus
                ? (STATUS_BADGE[lastStatus] ?? <span className="badge-gray">{lastStatus}</span>)
                : <span className="badge-gray">never run</span>
            }
            {job.needs_2fa && (
              <span className="badge-yellow">
                <AlertTriangle className="w-3 h-3" /> needs 2FA
              </span>
            )}
          </div>
        </div>

        {/* Details */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-500">
          <div><span className="font-medium text-gray-600">Album:</span> {job.album}</div>
          <div><span className="font-medium text-gray-600">Output:</span> {job.output_dir}</div>
          <div>
            <span className="font-medium text-gray-600">By album:</span>{' '}
            {job.organize_by_album ? '✓' : '✗'}
          </div>
          <div>
            <span className="font-medium text-gray-600">By year:</span>{' '}
            {job.organize_by_year ? `✓ (${job.folder_structure})` : '✗'}
          </div>
          {job.schedule_enabled && (
            <div className="col-span-2">
              <span className="font-medium text-gray-600">Schedule:</span>{' '}
              <code className="bg-gray-100 px-1 rounded">{job.cron_expression}</code>
            </div>
          )}
          {job.last_run_at && (
            <div className="col-span-2 text-gray-400">
              Last run: {formatDistanceToNow(new Date(job.last_run_at), { addSuffix: true })}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
          {isRunning ? (
            <button
              className="btn-danger btn-sm"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
            >
              <Square className="w-3 h-3" /> Stop
            </button>
          ) : (
            <button
              className="btn-success btn-sm"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Play className="w-3 h-3" />}
              Run
            </button>
          )}

          <Link to={`/jobs/${job.id}/edit`} className="btn-secondary btn-sm">
            <Edit className="w-3 h-3" /> Edit
          </Link>

          {/* View latest logs */}
          {job.run_id && (
            <Link to={`/jobs/${job.id}/logs/${job.run_id}`} className="btn-secondary btn-sm">
              Logs
            </Link>
          )}

          <button
            className="btn-secondary btn-sm ml-auto text-red-500 hover:text-red-700"
            onClick={() => {
              if (confirm(`Delete job "${job.name}"?`)) deleteMutation.mutate()
            }}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </>
  )
}

export default function Jobs() {
  const qc = useQueryClient()
  const [twoFAJob, setTwoFAJob] = useState(null)

  const { data: jobs, isLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.getJobs,
    refetchInterval: 3000,
  })

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {twoFAJob && (
        <TwoFAModal job={twoFAJob} onClose={() => setTwoFAJob(null)} />
      )}

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Jobs</h1>
          <p className="text-sm text-gray-500 mt-1">Manage and run your iCloud photo sync jobs</p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary btn-sm"
            onClick={() => qc.invalidateQueries(['jobs'])}
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
          <Link to="/jobs/new" className="btn-primary">
            <Plus className="w-4 h-4" /> New Job
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          Loading jobs…
        </div>
      ) : !jobs?.length ? (
        <div className="text-center py-16">
          <RefreshCw className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 mb-4">No sync jobs yet</p>
          <Link to="/jobs/new" className="btn-primary">
            <Plus className="w-4 h-4" /> Create your first sync job
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {jobs.map(job => (
            <JobCard key={job.id} job={job} onNeed2FA={setTwoFAJob} />
          ))}
        </div>
      )}
    </div>
  )
}
