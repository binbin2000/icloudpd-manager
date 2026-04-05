import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Save, ArrowLeft, Eye, EyeOff, Loader2, Info, RefreshCw, AlertTriangle, X } from 'lucide-react'

// ── Path preview helper ──────────────────────────────────────────────────────
// Converts the Python strftime format used by icloudpd (e.g. {:%Y/%m}) to a
// human-readable preview string using the current date.
function renderDateFormat(formatStr) {
  const now = new Date()
  const year  = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const monthName = now.toLocaleString('en-US', { month: 'long' })
  const day   = String(now.getDate()).padStart(2, '0')

  // ISO week number
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = String(Math.ceil((((d - yearStart) / 86400000) + 1) / 7)).padStart(2, '0')

  return formatStr.replace(/{:([^}]+)}/g, (_, fmt) =>
    fmt
      .replace('%Y', year)
      .replace('%m', month)
      .replace('%B', monthName)
      .replace('%d', day)
      .replace('%V', week)
      .replace('%W', week)
  )
}

// ── Album listing modal ───────────────────────────────────────────────────────
// Single-phase: silently discovers shared libraries, then lists Personal Library
// albums. Returns { albums, sharedLibraries } to the parent on success.
function AlbumListingModal({ username, password, onSuccess, onClose }) {
  const [sessionId, setSessionId] = useState(null)
  const [log, setLog]             = useState([])
  // status: starting | running | needs_2fa | error
  const [status, setStatus]       = useState('starting')
  const [twoFACode, setTwoFACode] = useState('')
  const [submitting2FA, setSubmit2FA] = useState(false)
  const logEndRef = useRef(null)

  // Start session on mount
  useEffect(() => {
    let cancelled = false
    api.startListSession(username, password)
      .then(({ session_id }) => { if (!cancelled) { setSessionId(session_id); setStatus('running') } })
      .catch(e => { if (!cancelled) { setLog([e.message]); setStatus('error') } })
    return () => { cancelled = true }
  }, [])

  // Poll while running
  useEffect(() => {
    if (!sessionId || status === 'error' || status === 'needs_2fa') return
    let cancelled = false

    const poll = async () => {
      try {
        const res = await api.getListSession(sessionId)
        if (cancelled) return
        setLog(res.log)
        if (res.needs_2fa) {
          setStatus('needs_2fa')
        } else if (res.status === 'success') {
          onSuccess({ albums: res.albums, sharedLibraries: res.shared_libraries || [] })
        } else if (res.status === 'error') {
          setStatus('error')
        } else {
          setTimeout(poll, 700)
        }
      } catch { if (!cancelled) setStatus('error') }
    }
    setTimeout(poll, 600)
    return () => { cancelled = true }
  }, [sessionId, status])

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log])

  const submit2FA = async () => {
    setSubmit2FA(true)
    try {
      await api.send2FAToSession(sessionId, twoFACode)
      setTwoFACode('')
      setStatus('running')
    } finally { setSubmit2FA(false) }
  }

  const headerLabel = {
    starting:  'Connecting to iCloud…',
    running:   'Fetching albums…',
    needs_2fa: 'Two-Factor Authentication',
    error:     'Connection failed',
  }[status] ?? 'Working…'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-lg shadow-xl flex flex-col" style={{ maxHeight: '82vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            {status === 'error'
              ? <AlertTriangle className="w-4 h-4 text-red-500" />
              : status === 'needs_2fa'
                ? <AlertTriangle className="w-4 h-4 text-yellow-500" />
                : <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
            }
            <span className="font-semibold text-sm text-gray-900">{headerLabel}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        {/* Log output */}
        <div className="flex-1 overflow-auto bg-gray-900 p-3 font-mono text-xs text-gray-300 min-h-24">
          {log.map((line, i) => (
            <div key={i} className={
              line.toLowerCase().includes('error') || line.toLowerCase().includes('fail')
                ? 'text-red-400'
                : line.toLowerCase().includes('warn') || line.toLowerCase().includes('refus') || line.startsWith('→')
                  ? 'text-yellow-300'
                  : 'text-gray-300'
            }>{line}</div>
          ))}
          {log.length === 0 && <div className="text-gray-600">Waiting for output…</div>}
          <div ref={logEndRef} />
        </div>

        {/* 2FA input */}
        {status === 'needs_2fa' && (
          <div className="p-4 border-t border-yellow-200 bg-yellow-50 space-y-2">
            <p className="text-sm text-yellow-800 font-medium">
              Enter the 6-digit code sent to your Apple device:
            </p>
            <div className="flex gap-2">
              <input
                className="input text-center font-mono tracking-widest flex-1"
                placeholder="000000"
                value={twoFACode}
                onChange={e => setTwoFACode(e.target.value.replace(/\D/g, ''))}
                maxLength={8}
                onKeyDown={e => e.key === 'Enter' && submit2FA()}
                autoFocus
              />
              <button className="btn-primary" onClick={submit2FA} disabled={!twoFACode || submitting2FA}>
                {submitting2FA ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit'}
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-3">
          {status === 'error' && (
            <p className="text-xs text-red-500 flex-1">
              If iCloud is refusing the connection, wait a few minutes and try again.
            </p>
          )}
          <button className="btn-secondary btn-sm ml-auto" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

const CRON_PRESETS = [
  { label: 'Every day at 2:00 AM', value: '0 2 * * *' },
  { label: 'Every 6 hours',        value: '0 */6 * * *' },
  { label: 'Every hour',           value: '0 * * * *' },
  { label: 'Every Sunday at midnight', value: '0 0 * * 0' },
  { label: 'First of each month',  value: '0 0 1 * *' },
  { label: 'Custom…',              value: '__custom__' },
]

const FOLDER_STRUCTURE_OPTIONS = [
  { label: 'Year only  (2024/)',           value: '{:%Y}' },
  { label: 'Year/Month (2024/06/)',        value: '{:%Y/%m}' },
  { label: 'Year/Month-name (2024/June/)', value: '{:%Y/%B}' },
  { label: 'Year/Week (2024/W23/)',        value: '{:%Y/W%V}' },
  { label: 'Custom (strftime format)',     value: '__custom__' },
]

function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <div className="relative mt-0.5 shrink-0">
        <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
        <div className={`w-10 h-6 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300'}`} />
        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </div>
      <div>
        <span className="text-sm font-medium text-gray-900">{label}</span>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
    </label>
  )
}

function Section({ title, children }) {
  return (
    <div className="card p-5 space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">{title}</h2>
      {children}
    </div>
  )
}

const makeDefaultForm = () => ({
  name: '',
  username: '',
  password: '',
  library: '',                   // SharedSync library name (auto-detected, hidden)
  include_shared_library: false, // when true, sync runs twice (Personal + Shared)
  album: 'All Photos',
  output_dir: '/photos',
  shared_output_dir: '',
  organize_by_album: true,
  sync_favorites: false,
  organize_by_year: true,
  folder_structure: '{:%Y}',
  date_from: '',
  date_to: '',
  schedule_enabled: false,
  cron_expression: '0 2 * * *',
  enabled: true,
})

export default function JobForm() {
  const { id } = useParams()
  const isEditing = Boolean(id)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [form, setForm] = useState(makeDefaultForm())
  const [showPassword, setShowPassword] = useState(false)
  const [cronPreset, setCronPreset] = useState('0 2 * * *')
  const [folderPreset, setFolderPreset] = useState('{:%Y}')
  const [errors, setErrors] = useState({})

  // Album / library listing state
  const [detectedSharedLib, setDetectedSharedLib] = useState(null) // e.g. "SharedSync-..."
  const [albums, setAlbums] = useState([])
  const [showListingModal, setShowListingModal] = useState(false)


  const { data: job } = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.getJob(id),
    enabled: isEditing,
  })

  useEffect(() => {
    if (job) {
      setForm({ ...makeDefaultForm(), ...job, library: job.library ?? '', date_from: job.date_from ?? '', date_to: job.date_to ?? '' })
      setCronPreset(
        CRON_PRESETS.find(p => p.value === job.cron_expression && p.value !== '__custom__')
          ? job.cron_expression : '__custom__'
      )
      setFolderPreset(
        FOLDER_STRUCTURE_OPTIONS.find(p => p.value === job.folder_structure && p.value !== '__custom__')
          ? job.folder_structure : '__custom__'
      )
      // Pre-populate detected shared library when editing a job
      if (job.library) setDetectedSharedLib(job.library)
    }
  }, [job])

  const set = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const openListingModal = () => {
    if (!form.username || !form.password) {
      alert('Enter your Apple ID and password first')
      return
    }
    setShowListingModal(true)
  }

  const validate = () => {
    const e = {}
    if (!form.name.trim())       e.name = 'Name is required'
    if (!form.username.trim())   e.username = 'Apple ID is required'
    if (!form.password.trim())   e.password = 'Password is required'
    if (!form.output_dir.trim()) e.output_dir = 'Output directory is required'
    if (form.schedule_enabled && !form.cron_expression.trim())
      e.cron_expression = 'Cron expression is required'
    if (form.date_from && form.date_to && form.date_from > form.date_to)
      e.date_to = 'End date must be after start date'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const mutation = useMutation({
    mutationFn: isEditing
      ? (data) => api.updateJob(id, data)
      : (data) => api.createJob(data),
    onSuccess: () => { qc.invalidateQueries(['jobs']); navigate('/jobs') },
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!validate()) return
    // Send null for empty optional strings
    mutation.mutate({
      ...form,
      library: form.library || null,
      shared_output_dir: form.shared_output_dir || null,
      date_from: form.date_from || null,
      date_to: form.date_to || null,
    })
  }

  // Preview of resulting folder path — year always comes before album.
  // renderDateFormat() converts the Python strftime pattern to a real date string.
  const datePart = form.organize_by_year ? renderDateFormat(form.folder_structure || '{:%Y}') : null
  // When "All Photos" + organize_by_album: show a placeholder so the user can
  // see that per-album subfolders will be created at sync time.
  const albumPart = form.organize_by_album
    ? (form.album && form.album !== 'All Photos' ? form.album : '<Album Name>')
    : null
  const pathPreview = [
    form.output_dir || '/photos',
    datePart,
    albumPart,
    'photo.jpg',
  ].filter(Boolean).join('/')

  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="btn-secondary btn-sm">
          <ArrowLeft className="w-3 h-3" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {isEditing ? 'Edit Sync Job' : 'New Sync Job'}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Configure an iCloud photo sync job</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* ── Basic ────────────────────────────────── */}
        <Section title="Basic Settings">
          <div>
            <label className="label">Job Name</label>
            <input
              className={`input ${errors.name ? 'border-red-400' : ''}`}
              placeholder="e.g. Family Photos"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
            {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
          </div>
          <Toggle
            checked={form.enabled}
            onChange={v => set('enabled', v)}
            label="Job enabled"
            description="Disabled jobs won't run on schedule"
          />
        </Section>

        {/* ── iCloud credentials ───────────────────── */}
        <Section title="iCloud Credentials">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex gap-2 text-xs text-blue-700">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Use your regular Apple ID and password. On the first run, iCloud will
              send a 2FA code to your trusted device — enter it in the prompt that
              appears in the live logs. After that, the session is saved and 2FA
              won't be needed again.
            </span>
          </div>
          <div>
            <label className="label">Apple ID (email)</label>
            <input
              className={`input ${errors.username ? 'border-red-400' : ''}`}
              type="email"
              placeholder="you@icloud.com"
              value={form.username}
              onChange={e => set('username', e.target.value)}
              autoComplete="off"
            />
            {errors.username && <p className="text-xs text-red-500 mt-1">{errors.username}</p>}
          </div>
          <div>
            <label className="label">Password</label>
            <div className="relative">
              <input
                className={`input pr-10 ${errors.password ? 'border-red-400' : ''}`}
                type={showPassword ? 'text' : 'password'}
                placeholder="Your iCloud password"
                value={form.password}
                onChange={e => set('password', e.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.password && <p className="text-xs text-red-500 mt-1">{errors.password}</p>}
          </div>
        </Section>

        {/* ── Library / Album ──────────────────────── */}
        <Section title="Library & Album">
          {showListingModal && (
            <AlbumListingModal
              username={form.username}
              password={form.password}
              onSuccess={({ albums: fetched, sharedLibraries }) => {
                const sharedLib = sharedLibraries[0] || null
                setDetectedSharedLib(sharedLib)
                setAlbums(fetched)
                setForm(f => ({
                  ...f,
                  library: sharedLib || f.library,
                  album: 'All Photos',
                  // Disable shared library toggle if none was found
                  ...(sharedLib ? {} : { include_shared_library: false }),
                }))
                setShowListingModal(false)
              }}
              onClose={() => setShowListingModal(false)}
            />
          )}

          {/* Fetch button */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-gray-500">
              Fetch albums and detect shared libraries from your iCloud account.
            </p>
            <button
              type="button"
              className="btn-secondary btn-sm shrink-0"
              onClick={openListingModal}
            >
              <RefreshCw className="w-3 h-3" />
              Fetch from iCloud
            </button>
          </div>

          {/* Album dropdown */}
          <div>
            <label className="label">Album</label>
            {albums.length > 0 ? (
              <select
                className="input"
                value={form.album}
                onChange={e => set('album', e.target.value)}
              >
                <option value="All Photos">All Photos</option>
                {albums.filter(a => a !== 'All Photos').map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                placeholder="All Photos"
                value={form.album}
                onChange={e => set('album', e.target.value)}
              />
            )}
            <p className="text-xs text-gray-400 mt-1">
              Use <strong>All Photos</strong> to sync everything, or pick a specific album.
              Click "Fetch from iCloud" to load available albums.
            </p>
          </div>

          {/* Shared library toggle */}
          <Toggle
            checked={form.include_shared_library}
            onChange={v => set('include_shared_library', v)}
            label="Sync shared library"
            description={
              detectedSharedLib
                ? `Also syncs ${detectedSharedLib} after Personal Library`
                : form.library
                  ? `Also syncs ${form.library} after Personal Library`
                  : 'Click "Fetch from iCloud" first to detect shared libraries'
            }
          />
          {form.include_shared_library && form.library && (
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded px-3 py-2 font-mono break-all">
              {form.library}
            </div>
          )}

          <div>
            <label className="label">Output Directory (Personal Library)</label>
            <input
              className={`input font-mono ${errors.output_dir ? 'border-red-400' : ''}`}
              placeholder="/data/photos"
              value={form.output_dir}
              onChange={e => set('output_dir', e.target.value)}
            />
            {errors.output_dir && <p className="text-xs text-red-500 mt-1">{errors.output_dir}</p>}
            <p className="text-xs text-gray-400 mt-1">
              Path inside the container. Mount your host photos folder to this
              path in docker-compose.yml (default volume: <code className="bg-gray-100 px-1 rounded">./photos:/photos</code>).
            </p>
          </div>
          {form.include_shared_library && (
            <div>
              <label className="label">Output Directory (Shared Library)</label>
              <input
                className="input font-mono"
                placeholder={`${form.output_dir || '/data/photos'}/Shared Library`}
                value={form.shared_output_dir}
                onChange={e => set('shared_output_dir', e.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1">
                Where shared photos are stored. Leave blank to use a{' '}
                <code className="bg-gray-100 px-1 rounded">Shared Library/</code>{' '}
                subfolder inside the Personal Library directory. Mount a separate
                Docker volume here to keep libraries on different disks.
              </p>
            </div>
          )}
        </Section>

        {/* ── Folder structure ─────────────────────── */}
        <Section title="Folder Organisation">
          <Toggle
            checked={form.organize_by_album}
            onChange={v => set('organize_by_album', v)}
            label="Create subfolder per album"
            description="Photos saved in output_dir/AlbumName/"
          />
          {form.organize_by_album && (!form.album || form.album === 'All Photos') && (
            <Toggle
              checked={form.sync_favorites}
              onChange={v => set('sync_favorites', v)}
              label="Include Favorites album"
              description="Creates a Favorites/ folder — photos already appear in their own albums"
            />
          )}
          <Toggle
            checked={form.organize_by_year}
            onChange={v => set('organize_by_year', v)}
            label="Organise by date"
            description="Creates date-based subfolders"
          />
          {form.organize_by_year && (
            <div>
              <label className="label">Date folder format</label>
              <select
                className="input"
                value={folderPreset}
                onChange={e => {
                  setFolderPreset(e.target.value)
                  if (e.target.value !== '__custom__') set('folder_structure', e.target.value)
                }}
              >
                {FOLDER_STRUCTURE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {folderPreset === '__custom__' && (
                <input
                  className="input mt-2 font-mono"
                  placeholder="{:%Y/%m}"
                  value={form.folder_structure}
                  onChange={e => set('folder_structure', e.target.value)}
                />
              )}
            </div>
          )}
          <div className="bg-gray-50 rounded-lg p-3 text-xs font-mono text-gray-500 break-all">
            📁 {pathPreview}
          </div>
        </Section>

        {/* ── Date range ───────────────────────────── */}
        <Section title="Date Range Filter">
          <p className="text-xs text-gray-500">
            Filter by <strong>photo taken date</strong> (the date the photo was shot, from EXIF).
            Leave blank to sync all available photos.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Taken on or after</label>
              <input
                type="date"
                className="input"
                value={form.date_from}
                onChange={e => set('date_from', e.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1">Skip photos taken before this date</p>
            </div>
            <div>
              <label className="label">Taken on or before</label>
              <input
                type="date"
                className="input"
                value={form.date_to}
                onChange={e => set('date_to', e.target.value)}
                min={form.date_from || undefined}
              />
              <p className="text-xs text-gray-400 mt-1">Skip photos taken after this date</p>
              {errors.date_to && <p className="text-xs text-red-500 mt-1">{errors.date_to}</p>}
            </div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs text-gray-500">
            Passed to icloudpd as <code className="bg-gray-100 px-1 rounded">--skip-created-before</code> / <code className="bg-gray-100 px-1 rounded">--skip-created-after</code>.
          </div>
        </Section>

        {/* ── Schedule ─────────────────────────────── */}
        <Section title="Schedule">
          <Toggle
            checked={form.schedule_enabled}
            onChange={v => set('schedule_enabled', v)}
            label="Enable automatic scheduling"
            description="Job runs automatically on the configured interval"
          />
          {form.schedule_enabled && (
            <div className="space-y-3">
              <div>
                <label className="label">Preset</label>
                <select
                  className="input"
                  value={cronPreset}
                  onChange={e => {
                    setCronPreset(e.target.value)
                    if (e.target.value !== '__custom__') set('cron_expression', e.target.value)
                  }}
                >
                  {CRON_PRESETS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Cron expression (UTC)</label>
                <input
                  className={`input font-mono ${errors.cron_expression ? 'border-red-400' : ''}`}
                  placeholder="0 2 * * *"
                  value={form.cron_expression}
                  onChange={e => { set('cron_expression', e.target.value); setCronPreset('__custom__') }}
                />
                {errors.cron_expression && (
                  <p className="text-xs text-red-500 mt-1">{errors.cron_expression}</p>
                )}
                <p className="text-xs text-gray-400 mt-1">
                  Format: <code className="bg-gray-100 px-1 rounded">minute hour day month weekday</code>
                </p>
              </div>
            </div>
          )}
        </Section>

        {/* ── Submit ───────────────────────────────── */}
        <div className="flex gap-3 justify-end">
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isEditing ? 'Save Changes' : 'Create Job'}
          </button>
        </div>

        {mutation.isError && (
          <div className="card p-3 border-red-200 bg-red-50 text-sm text-red-700">
            {mutation.error.message}
          </div>
        )}
      </form>
    </div>
  )
}
