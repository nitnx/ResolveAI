import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api/client';
import ChatPage from './pages/ChatPage';
import DashboardPage from './pages/DashboardPage';

function NavBar() {
  return (
    <nav className="sticky top-0 z-40 flex items-center gap-8 border-b border-slate-800 bg-gradient-to-r from-slate-900 via-slate-900 to-indigo-950 px-6 py-3.5 text-white shadow-lg">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-sm font-black shadow-md">
          R
        </span>
        <div className="flex flex-col leading-none">
          <span className="text-lg font-bold tracking-tight text-white">ResolveAI</span>
          <span className="text-[10px] font-medium uppercase tracking-widest text-indigo-300">
            Support Triage Copilot
          </span>
        </div>
      </div>
      <div className="flex gap-1">
        <NavLink
          to="/chat"
          className={({ isActive }) =>
            `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? 'bg-white/10 text-white'
                : 'text-slate-300 hover:bg-white/5 hover:text-white'
            }`
          }
        >
          Chat
        </NavLink>
        <NavLink
          to="/dashboard"
          className={({ isActive }) =>
            `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? 'bg-white/10 text-white'
                : 'text-slate-300 hover:bg-white/5 hover:text-white'
            }`
          }
        >
          Dashboard
        </NavLink>
      </div>
      <span className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/20">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Mock AI · No keys needed
      </span>
    </nav>
  );
}

/** Checks backend health on mount and blocks render on a seed-load failure. */
function useInitCheck() {
  // 'checking' | 'ok' | 'failed'
  const [initState, setInitState] = useState<'checking' | 'ok' | 'failed'>('checking');

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((result) => {
        if (cancelled) return;
        // Backend returns { status: 'seed_failed' } if it ever surfaces that state
        if (result.status === 'seed_failed') {
          setInitState('failed');
        } else {
          setInitState('ok');
        }
      })
      .catch(() => {
        if (!cancelled) setInitState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return initState;
}

function InitCheckingScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <svg
          className="h-8 w-8 animate-spin text-indigo-500"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
        <p className="text-sm text-gray-500">Connecting to ResolveAI…</p>
      </div>
    </div>
  );
}

function SeedFailedScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-xl border border-red-200 bg-red-50 p-8 text-center shadow-sm">
        <div className="mb-4 flex justify-center">
          <svg
            className="h-12 w-12 text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>
        <h1 className="text-lg font-semibold text-red-800 mb-2">
          ResolveAI failed to initialize
        </h1>
        <p className="text-sm text-red-700 leading-relaxed mb-4">
          Sample data could not be loaded, or the backend server is not reachable.
          Please restart the server and refresh this page.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const initState = useInitCheck();

  if (initState === 'checking') {
    return <InitCheckingScreen />;
  }

  if (initState === 'failed') {
    return <SeedFailedScreen />;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <NavBar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </main>
    </div>
  );
}
