import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { RefreshCw, CheckCircle, Play, Plus, Clock } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

function StatCard({ icon: Icon, label, value, color = 'blue' }) {
  const colors = {
    blue:    'bg-blue-50   text-blue-600',
    green:   'bg-emerald-50 text-emerald-600',
    yellow:  'bg-yellow-50  text-yellow-600',
    purple:  'bg-purple-50  text-purple-600',
  }
  return (
    <div className="card p-4 sm:p-5 flex items-center gap-3 sm:gap-4">
      <div className={`p-2.5 sm:p-3 rounded-lg shrink-0 ${colors[color]}`}>
        <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xl sm:text-2xl font-bold text-gray-900">{value ?? '—'}</p>
        <p className="text-xs sm:text-sm text-gray-500 truncate">{label}</p>
      </div>
    </div>
  )
}

function JobRow({ job }) {
  const statusColor = {
    success: 'badge-green',
    error:   'badge-red',
    running: 'badge-blue',
    stopped: 'badge-gray',
  }[job.last_run_status] ?? 'badge-gray'

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-sm font-medium text-gray-900 max-w-[120px] truncate">{job.name}</td>
      <td className="px-4 py-3 text-sm text-gray-500 hidden sm:table-cell max-w-[120px] truncate">{job.album}</td>
      <td className="px-4 py-3">
        {job.last_run_status ? (
          <span className={statusColor}>{job.last_run_status}</span>
        ) : (
          <span className="badge-gray">never run</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-400 hidden md:table-cell whitespace-nowrap">
        {job.last_run_at
          ? formatDistanceToNow(new Date(job.last_run_at), { addSuffix: true })
          : '—'}
      </td>
      <td className="px-4 py-3 hidden lg:table-cell">
        {job.schedule_enabled ? (
          <span className="badge-green">
            <Clock className="w-3 h-3" /> scheduled
          </span>
        ) : (
          <span className="badge-gray">manual</span>
        )}
      </td>
      <td className="px-4 py-3">
        <Link
          to={`/jobs/${job.id}/edit`}
          className="text-sm text-blue-600 hover:underline"
        >
          Edit
        </Link>
      </td>
    </tr>
  )
}

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: api.getStats,
    refetchInterval: 5000,
  })
  const { data: jobs, isLoading: jobsLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.getJobs,
    refetchInterval: 5000,
  })

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <div className="mb-6 sm:mb-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Overview of your iCloud sync jobs</p>
        </div>
        <Link to="/jobs/new" className="btn-primary">
          <Plus className="w-4 h-4" /> New Sync Job
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-8">
        <StatCard icon={RefreshCw}   label="Total Jobs"      value={stats?.total_jobs}      color="blue" />
        <StatCard icon={Play}        label="Running Now"     value={stats?.running_jobs}     color="yellow" />
        <StatCard icon={CheckCircle} label="Successful Runs" value={stats?.successful_runs}  color="green" />
        <StatCard icon={Clock}       label="Active Jobs"     value={stats?.active_jobs}      color="purple" />
      </div>

      {/* Recent jobs table */}
      <div className="card overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Sync Jobs</h2>
        </div>
        {jobsLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : !jobs?.length ? (
          <div className="p-8 text-center">
            <p className="text-gray-400 text-sm mb-4">No sync jobs yet</p>
            <Link to="/jobs/new" className="btn-primary btn-sm">
              <Plus className="w-3 h-3" /> Create your first job
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide hidden sm:table-cell">Album</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide hidden md:table-cell">Last Run</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wide hidden lg:table-cell">Schedule</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {jobs.map(job => <JobRow key={job.id} job={job} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
