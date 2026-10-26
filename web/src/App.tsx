import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, setOnUnauthorized, type QueueStatus } from "./api";
import { clock } from "./format";
import { useReloadable } from "./hooks";
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
  const { data: status, reload } = useReloadable(() => api<QueueStatus>("/api/status"), 5000);
  const [busy, setBusy] = useState(false);

  async function setPaused(paused: boolean) {
    setBusy(true);
    try {
      await api("/api/queue", { method: "POST", body: { paused } });
      await reload();
    } finally {
      setBusy(false);
    }
  }

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
        {status && !status.queue_paused && (
          <button
            className="secondary small"
            disabled={busy}
            title="Running tasks finish; nothing new starts. Use it before a deploy."
            onClick={() => setPaused(true)}
          >
            Pause new runs
          </button>
        )}
        <button className="link" onClick={logout}>
          Log out
        </button>
      </header>
      {status?.queue_paused && (
        <div className="banner warn banner-row">
          <span>
            New runs are paused.{" "}
            {status.running === 0
              ? "Nothing is running, so it's safe to deploy now."
              : `${status.running} still running. It's safe to deploy once that reaches 0.`}
          </span>
          <button className="secondary small" disabled={busy} onClick={() => setPaused(false)}>
            Resume
          </button>
        </div>
      )}
      {status?.paused_reason && !status.queue_paused && (
        <div className="banner warn">
          {status.paused_reason}{" "}
          {status.paused_until
            ? `New runs start again after ${clock(status.paused_until)}, and interrupted tasks continue automatically.`
            : "Queued runs wait until one can."}
        </div>
      )}
    </>
  );
}
