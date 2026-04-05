import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { LayoutDashboard, RefreshCw, Plus, Cloud } from 'lucide-react'
import Dashboard from './pages/Dashboard'
import Jobs from './pages/Jobs'
import JobForm from './pages/JobForm'
import Logs from './pages/Logs'

function Sidebar() {
  const link = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors
     ${isActive ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`

  return (
    <aside className="w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-4 py-5 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Cloud className="w-6 h-6 text-blue-600" />
          <span className="font-bold text-gray-900 text-lg">iCloud Sync</span>
        </div>
        <p className="text-xs text-gray-400 mt-0.5">Photo sync manager</p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        <NavLink to="/dashboard" className={link}>
          <LayoutDashboard className="w-4 h-4" /> Dashboard
        </NavLink>
        <NavLink to="/jobs" className={link}>
          <RefreshCw className="w-4 h-4" /> Sync Jobs
        </NavLink>
        <NavLink to="/jobs/new" className={link}>
          <Plus className="w-4 h-4" /> New Job
        </NavLink>
      </nav>
      <div className="p-4 border-t border-gray-200">
        <p className="text-xs text-gray-400">iCloud Sync Manager v1.0</p>
      </div>
    </aside>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-gray-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/jobs/new" element={<JobForm />} />
            <Route path="/jobs/:id/edit" element={<JobForm />} />
            <Route path="/jobs/:id/logs/:runId" element={<Logs />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
