import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, setOnUnauthorized, type QueueStatus } from "./api";
import { clock } from "./format";
import { usePolling } from "./hooks";
import { Keys } from "./pages/Keys";
import { Login } from "./pages/Login";
import { NewTask } from "./pages/NewTask";
import { SettingsPage } from "./pages/Settings";
import { TaskDetail } from "./pages/TaskDetail";
import { Tasks } from "./pages/Tasks";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setOnUnauthorized(() => setAuthed(false));
    api("/api/auth/me")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return null;
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  return (
    <div className="shell">
      <Header onLoggedOut={() => setAuthed(false)} />
      <main className="page">
        <Routes>
          <Route path="/" element={<Tasks />} />
          <Route path="/new" element={<NewTask />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ onLoggedOut }: { onLoggedOut: () => void }) {
  const status = usePolling(() => api<QueueStatus>("/api/status"), 5000);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    onLoggedOut();
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">Arjun</div>
        <nav>
          <NavLink to="/" end>
            Tasks
          </NavLink>
          <NavLink to="/new">New task</NavLink>
          <NavLink to="/keys">API keys</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        {status && (
          <div className="queue-meter" title="Runs going now / limit, and runs waiting">
            <span className="mono">
              {status.running}/{status.max_concurrency}
            </span>{" "}
            running · <span className="mono">{status.queued}</span> queued
          </div>
        )}
        <button className="link" onClick={logout}>
          Log out
        </button>
      </header>
      {status?.paused_until && (
        <div className="banner warn">
          The Max plan's usage limit was reached. New runs start again after {clock(status.paused_until)}, and
          interrupted tasks continue automatically.
        </div>
      )}
    </>
  );
}
