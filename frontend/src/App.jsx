import { useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { LayoutDashboard, RefreshCw, Plus, Cloud, Menu, X } from 'lucide-react'
import Dashboard from './pages/Dashboard'
import Jobs from './pages/Jobs'
import JobForm from './pages/JobForm'
import Logs from './pages/Logs'

function Sidebar({ open, onClose }) {
  const link = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors
     ${isActive ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-20 md:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        fixed md:static inset-y-0 left-0 z-30
        w-64 md:w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col
        transition-transform duration-200 ease-in-out
        ${open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div className="px-4 py-5 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cloud className="w-6 h-6 text-blue-600" />
              <span className="font-bold text-gray-900 text-lg">iCloud Sync</span>
            </div>
            <button
              className="md:hidden p-1 text-gray-400 hover:text-gray-600"
              onClick={onClose}
              aria-label="Close menu"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Photo sync manager</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <NavLink to="/dashboard" className={link} onClick={onClose}>
            <LayoutDashboard className="w-4 h-4" /> Dashboard
          </NavLink>
          <NavLink to="/jobs" className={link} onClick={onClose}>
            <RefreshCw className="w-4 h-4" /> Sync Jobs
          </NavLink>
          <NavLink to="/jobs/new" className={link} onClick={onClose}>
            <Plus className="w-4 h-4" /> New Job
          </NavLink>
        </nav>
        <div className="p-4 border-t border-gray-200">
          <p className="text-xs text-gray-400">iCloud Sync Manager v1.0</p>
        </div>
      </aside>
    </>
  )
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-gray-50">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Mobile top bar */}
          <header className="md:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
            <button
              className="text-gray-500 hover:text-gray-700"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2">
              <Cloud className="w-5 h-5 text-blue-600" />
              <span className="font-bold text-gray-900">iCloud Sync</span>
            </div>
          </header>
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
      </div>
    </BrowserRouter>
  )
}
