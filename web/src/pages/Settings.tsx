import { useEffect, useState, type FormEvent } from "react";
import { api, type Account, type Settings } from "../api";
import { Field } from "../components";
import { clock, timeAgo } from "../format";
import { useReloadable } from "../hooks";

interface SettingsResponse {
  settings: Settings;
  models: string[];
  efforts: string[];
}

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SettingsResponse>("/api/settings").then((d) => {
      setData(d);
      setForm(d.settings);
    });
  }, []);

  if (!data || !form) return <div className="muted">Loading…</div>;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<SettingsResponse>("/api/settings", { method: "PATCH", body: form });
      setData(res);
      setForm(res.settings);
      setMessage({ ok: true, text: "Saved. The queue uses the new values right away." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const models = [...new Set([...data.models, form.default_model])];

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <Accounts thresholds={data.settings} />
      <form className="card form" onSubmit={save}>
        <h2>Queue</h2>
        <Field
          label="Max runs at once"
          htmlFor="max_concurrency"
          hint="More at once reaches each account's usage limit sooner. Lowering it never stops running tasks."
        >
          <input
            id="max_concurrency"
            className="narrow"
            type="number"
            min={1}
            max={20}
            value={form.max_concurrency}
            onChange={(e) => set("max_concurrency", Number(e.target.value))}
          />
        </Field>

        <h2>Switching accounts</h2>
        <p className="muted">
          New runs go to the first account in the list below until it has used this much, then to the next one, and so
          on. When every account is past these points, the first one with any room left is used.
        </p>
        <div className="row four">
          <Field label="5-hour usage (%)" htmlFor="switch_at_5h_pct">
            <input
              id="switch_at_5h_pct"
              type="number"
              min={1}
              max={100}
              value={form.switch_at_5h_pct}
              onChange={(e) => set("switch_at_5h_pct", Number(e.target.value))}
            />
          </Field>
          <Field label="Weekly usage (%)" htmlFor="switch_at_weekly_pct">
            <input
              id="switch_at_weekly_pct"
              type="number"
              min={1}
              max={100}
              value={form.switch_at_weekly_pct}
              onChange={(e) => set("switch_at_weekly_pct", Number(e.target.value))}
            />
          </Field>
        </div>

        <h2>Defaults for new tasks</h2>
        <p className="muted">Used to fill in the new task form, and when an API call leaves a field out.</p>
        <div className="row four">
          <Field label="Model" htmlFor="default_model">
            <select id="default_model" value={form.default_model} onChange={(e) => set("default_model", e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort" htmlFor="default_effort">
            <select id="default_effort" value={form.default_effort} onChange={(e) => set("default_effort", e.target.value)}>
              {data.efforts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" htmlFor="default_priority" hint="1 is the highest.">
            <select
              id="default_priority"
              value={form.default_priority}
              onChange={(e) => set("default_priority", Number(e.target.value))}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Timeout (minutes)" htmlFor="default_timeout_min">
            <input
              id="default_timeout_min"
              type="number"
              min={1}
              max={1440}
              value={form.default_timeout_min}
              onChange={(e) => set("default_timeout_min", Number(e.target.value))}
            />
          </Field>
        </div>

        {message && <div className={message.ok ? "form-ok" : "form-error"}>{message.text}</div>}
        <div className="actions">
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </>
  );
}

function Accounts({ thresholds }: { thresholds: Settings }) {
  const accounts = useReloadable(() => api<Account[]>("/api/accounts"), 15_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, method = "POST", body: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      await api<Account[]>(path, { method, body });
      await accounts.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const list = accounts.data ?? [];
  return (
    <section className="card accounts">
      <div className="latest-head">
        <h2>Claude accounts</h2>
        <button className="secondary" disabled={busy} onClick={() => act("/api/accounts/check")}>
          Check usage now
        </button>
      </div>
      <p className="muted">
        Tried from the top. To add one, open the container's terminal and run <code>add-account &lt;name&gt;</code>{" "}
        (e.g. <code>add-account third</code>), then <code>/login</code> in the Claude that opens. It appears here at the
        bottom within a minute. Run the same command to log an account in again.
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Status</th>
              <th>5 hours</th>
              <th>Week</th>
              <th className="num">Running</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((a, i) => (
              <tr key={a.id} className={a.enabled ? "" : "revoked"}>
                <td className="mono">{i + 1}</td>
                <td>
                  <div className="task-title">{a.name}</div>
                  <div className="sub mono">{a.config_dir}</div>
                </td>
                <td>
                  <span className={`pill ${a.state === "Ready" ? "pill-done" : a.enabled ? "pill-limited" : "pill-cancelled"}`}>
                    {a.state}
                  </span>
                  {a.next && <div className="sub">New runs go here</div>}
                  {a.limited_until && <div className="sub">Until {clock(a.limited_until)}</div>}
                  {a.login_error && <div className="sub">{a.login_error}</div>}
                </td>
                <td>
                  <Usage pct={a.five_hour_pct} resetsAt={a.five_hour_resets_at} switchAt={thresholds.switch_at_5h_pct} />
                </td>
                <td>
                  <Usage pct={a.seven_day_pct} resetsAt={a.seven_day_resets_at} switchAt={thresholds.switch_at_weekly_pct} />
                </td>
                <td className="num">{a.running}</td>
                <td className="right">
                  <span className="account-actions">
                    <button className="secondary" disabled={busy || i === 0} title="Try earlier" onClick={() => act(`/api/accounts/${a.id}/move`, "POST", { direction: "up" })}>
                      ↑
                    </button>
                    <button className="secondary" disabled={busy || i === list.length - 1} title="Try later" onClick={() => act(`/api/accounts/${a.id}/move`, "POST", { direction: "down" })}>
                      ↓
                    </button>
                    {(a.login_error || a.limited_until) && (
                      <button className="secondary" disabled={busy} onClick={() => act(`/api/accounts/${a.id}/reset`)}>
                        Try again
                      </button>
                    )}
                    {!a.folder_exists && !a.is_main ? (
                      <button className="secondary" disabled={busy} onClick={() => act(`/api/accounts/${a.id}/forget`)}>
                        Remove
                      </button>
                    ) : (
                      <button className="secondary" disabled={busy} onClick={() => act(`/api/accounts/${a.id}`, "PATCH", { enabled: !a.enabled })}>
                        {a.enabled ? "Turn off" : "Turn on"}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {accounts.data && list.length === 0 && <div className="empty">No accounts yet.</div>}
      </div>
      {list.some((a) => a.usage_error) && (
        <p className="hint">
          {list
            .filter((a) => a.usage_error)
            .map((a) => `${a.name}: ${a.usage_error}`)
            .join(" ")}{" "}
          Without a reading, an account is used until Claude says its limit is reached.
        </p>
      )}
      {list[0]?.usage_checked_at && <p className="hint">Usage checked {timeAgo(list[0].usage_checked_at)}.</p>}
    </section>
  );
}

function Usage({ pct, resetsAt, switchAt }: { pct: number | null; resetsAt: string | null; switchAt: number }) {
  if (pct == null) return <span className="muted">–</span>;
  const level = pct >= 100 ? "full" : pct >= switchAt ? "high" : "";
  return (
    <div className="usage" title={`Switches to the next account at ${switchAt}%`}>
      <div className={`meter ${level}`}>
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="sub">
        <span className="mono">{Math.round(pct)}%</span>
        {resetsAt && ` · resets ${clock(resetsAt)}`}
      </div>
    </div>
  );
}
