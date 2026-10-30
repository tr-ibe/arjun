import { useEffect, useState, type FormEvent } from "react";
import { api, type Account, type Settings, type Tools } from "../api";
import { Field } from "../components";
import { clock, timeAgo } from "../format";
import { useReloadable } from "../hooks";

interface SettingsResponse {
  settings: Settings;
  models: string[];
  efforts: string[];
  alert_statuses: string[];
  slack_configured: boolean;
}

const ALERT_STATUS_LABEL: Record<string, string> = { stuck: "Stuck", error: "Error", timeout: "Timed out" };

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

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

  async function testAlert() {
    setTesting(true);
    setMessage(null);
    try {
      await api("/api/alerts/test", { method: "POST" });
      setMessage({ ok: true, text: "Test alert sent. Check the channel." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const toggleStatus = (status: string, on: boolean) =>
    set(
      "alert_statuses",
      data.alert_statuses.filter((s) => (s === status ? on : form.alert_statuses.includes(s))),
    );

  const models = [...new Set([...data.models, form.default_model])];

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <Accounts thresholds={data.settings} />
      <ArjunTools />
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

        <h2>Sharing runs between accounts</h2>
        <p className="muted">
          The main account is the primary. It takes every new run until it has used this much. Then its remaining room
          is kept in reserve, and new runs are shared between the fallback accounts: more to an account whose room resets
          sooner (so it isn't lost), to bigger plans, and to accounts with fewer runs going. An account using its week
          faster than an even pace gets less. Main's reserve is used only when no fallback has room.
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

        <h2>Slack alerts</h2>
        <p className="muted">
          Posted by Arjun in one channel: when a task ends needing someone, when the queue has been left paused, and
          when no Claude account can take runs. Invite Arjun to the channel first.
        </p>
        {!data.slack_configured && (
          <div className="form-error">
            Set <code>SLACK_USER_TOKEN</code> to send alerts. They're posted as Arjun.
          </div>
        )}
        <div className="row">
          <Field label="Channel" htmlFor="alert_channel" hint="Its ID (in the channel's details) or name. Empty turns alerts off.">
            <input
              id="alert_channel"
              placeholder="C0123ABCD or #arjun-alerts"
              value={form.alert_channel}
              onChange={(e) => set("alert_channel", e.target.value)}
            />
          </Field>
          <Field label="Console address" htmlFor="public_url" hint="For links to the task in each alert.">
            <input
              id="public_url"
              type="url"
              placeholder="https://arjun.example.com"
              value={form.public_url}
              onChange={(e) => set("public_url", e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Alert when a task ends as"
          htmlFor="alert_status_stuck"
          hint="Not when Arjun retries it himself (a usage limit, a broken login, a restart)."
        >
          <div className="checks">
            {data.alert_statuses.map((s) => (
              <label key={s} className="check">
                <input
                  id={`alert_status_${s}`}
                  type="checkbox"
                  checked={form.alert_statuses.includes(s)}
                  onChange={(e) => toggleStatus(s, e.target.checked)}
                />
                {ALERT_STATUS_LABEL[s] ?? s}
              </label>
            ))}
          </div>
        </Field>
        <div className="row four">
          <Field label="Paused queue: first alert after (min)" htmlFor="alert_pause_after_min" hint="0 turns it off.">
            <input
              id="alert_pause_after_min"
              type="number"
              min={0}
              max={1440}
              value={form.alert_pause_after_min}
              onChange={(e) => set("alert_pause_after_min", Number(e.target.value))}
            />
          </Field>
          <Field label="Then again every (min)" htmlFor="alert_pause_every_min" hint="Until it's resumed. 0 for only once.">
            <input
              id="alert_pause_every_min"
              type="number"
              min={0}
              max={1440}
              value={form.alert_pause_every_min}
              onChange={(e) => set("alert_pause_every_min", Number(e.target.value))}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={form.alert_no_accounts}
            onChange={(e) => set("alert_no_accounts", e.target.checked)}
          />
          Alert when no Claude account can take runs (all past their limits, off, or logged out), and when one can again
        </label>

        {message && <div className={message.ok ? "form-ok" : "form-error"}>{message.text}</div>}
        <div className="actions">
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          <button type="button" className="secondary" disabled={testing || !data.slack_configured} onClick={testAlert}>
            {testing ? "Sending…" : "Send a test alert"}
          </button>
          <span className="hint">The test uses the saved channel.</span>
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
        Main is the primary; every other account is a fallback. To add a fallback, open the container's terminal and run{" "}
        <code>add-account &lt;name&gt;</code> (e.g. <code>add-account third</code>), then <code>/login</code> in the Claude
        that opens. It appears here within a minute. Run the same command to log an account in again. To remove one, turn
        it off, delete its folder (<code>rm -rf ~/accounts/&lt;name&gt;</code>) and press <strong>Remove</strong>.
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Status</th>
              <th>5 hours</th>
              <th>Week</th>
              <th>Plan</th>
              <th className="num">Running</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} className={a.enabled ? "" : "revoked"}>
                <td>
                  <div className="task-title">{a.name}</div>
                  <div className="sub">{a.is_main ? "Primary" : "Fallback"}</div>
                  <div className="sub mono">{a.config_dir}</div>
                </td>
                <td>
                  <span className={`pill ${a.state === "Ready" ? "pill-done" : a.state === "In reserve" ? "pill-queued" : a.enabled ? "pill-limited" : "pill-cancelled"}`}>
                    {a.state}
                  </span>
                  {a.next && <div className="sub">Next run goes here</div>}
                  {a.share_pct != null && <div className="sub">{a.share_pct}% of new runs</div>}
                  {a.limited_until && <div className="sub">Until {clock(a.limited_until)}</div>}
                  {a.login_error && <div className="sub">{a.login_error}</div>}
                </td>
                <td>
                  <Usage pct={a.five_hour_pct} resetsAt={a.five_hour_resets_at} switchAt={a.is_main ? thresholds.switch_at_5h_pct : undefined} />
                </td>
                <td>
                  {a.weekly_limit ? (
                    <Usage pct={a.seven_day_pct} resetsAt={a.seven_day_resets_at} switchAt={a.is_main ? thresholds.switch_at_weekly_pct : undefined} />
                  ) : (
                    <span className="muted">No weekly limit</span>
                  )}
                </td>
                <td>
                  <select
                    aria-label={`Plan of ${a.name}`}
                    disabled={busy}
                    value={a.plan_size_set == null ? "" : String(a.plan_size_set)}
                    onChange={(e) =>
                      act(`/api/accounts/${a.id}`, "PATCH", { plan_size: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  >
                    <option value="">Auto ({planLabel(a.plan_size_auto)})</option>
                    {PLANS.map((p) => (
                      <option key={p.size} value={p.size}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num">{a.running}</td>
                <td className="right">
                  <span className="account-actions">
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
          Without a reading, an account counts as having room until Claude says its limit is reached.
        </p>
      )}
      {list[0]?.usage_checked_at && <p className="hint">Usage checked {timeAgo(list[0].usage_checked_at)}.</p>}
    </section>
  );
}

// What every run gets from Arjun itself, the same whichever Claude account it lands on.
function ArjunTools() {
  const tools = useReloadable(() => api<Tools>("/api/tools"), 60_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      await api<Tools>("/api/tools/check", { method: "POST" });
      await tools.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const plugins = tools.data?.plugins ?? [];
  const mytribe = tools.data?.mytribe;
  const slack = tools.data?.slack;
  return (
    <section className="card accounts">
      <div className="latest-head">
        <h2>From Arjun</h2>
        <button className="secondary" disabled={busy} onClick={check}>
          {busy ? "Checking…" : "Check now"}
        </button>
      </div>
      <p className="muted">
        Every run gets these from Arjun, whichever Claude account it lands on. The accounts only provide usage.
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Plugin</th>
              <th>Version</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <tr key={p.source}>
                <td>
                  <div className="task-title">{p.name ?? "–"}</div>
                  <div className="sub mono">{p.source}</div>
                </td>
                <td>
                  {p.version ? <span className="mono">{p.version}</span> : <span className="muted">–</span>}
                  {p.commit && (
                    <div className="sub">
                      <span className="mono">{p.commit}</span>
                      {p.committed_at && ` · ${timeAgo(p.committed_at)}`}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`pill ${p.error ? (p.version ? "pill-limited" : "pill-error") : "pill-done"}`}>
                    {p.error ? (p.version ? "Using last copy" : "Not loaded") : "Up to date"}
                  </span>
                  {p.error && <div className="sub">{p.error}</div>}
                  {p.checked_at && <div className="sub">Checked {timeAgo(p.checked_at)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tools.data && plugins.length === 0 && <div className="empty">No plugins set. See PLUGINS in the README.</div>}
      </div>
      {mytribe && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Signed in to</th>
                <th>As</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div className="task-title">mytribe CLI</div>
                  <div className="sub mono">~/.mytribe</div>
                </td>
                <td>
                  {mytribe.email ?? <span className="muted">–</span>}
                  {mytribe.roles.length > 0 && <div className="sub">{mytribe.roles.join(", ")}</div>}
                </td>
                <td>
                  <span className={`pill ${mytribe.error ? "pill-error" : "pill-done"}`}>
                    {mytribe.error ? "Not working" : "Signed in"}
                  </span>
                  {mytribe.error && <div className="sub">{mytribe.error}</div>}
                  {mytribe.error && (
                    <div className="sub">
                      To sign in again, in the container's terminal: <code>mytribe login arjun@mytribe.in</code>, then{" "}
                      <code>mytribe login --code &lt;code&gt;</code> with the code from the email.
                    </div>
                  )}
                  {mytribe.checked_at && <div className="sub">Checked {timeAgo(mytribe.checked_at)}</div>}
                </td>
              </tr>
              {slack && (
                <tr>
                  <td>
                    <div className="task-title">Slack</div>
                    <div className="sub mono">Slack's MCP server</div>
                  </td>
                  <td>
                    {slack.user ? (
                      <>
                        {slack.user}
                        {slack.team && <div className="sub">{slack.team} workspace</div>}
                      </>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${!slack.configured || slack.error ? "pill-error" : "pill-done"}`}>
                      {!slack.configured ? "Not set up" : slack.error ? "Not working" : "Signed in"}
                    </span>
                    {!slack.configured && (
                      <div className="sub">
                        Set <code>SLACK_USER_TOKEN</code>. Until then, runs use the Slack connector of the account they're on.
                      </div>
                    )}
                    {slack.error && <div className="sub">{slack.error}</div>}
                    {slack.checked_at && <div className="sub">Checked {timeAgo(slack.checked_at)}</div>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Plan sizes, as multiples of Pro. A bigger plan takes a bigger share of the runs.
const PLANS = [
  { size: 1, label: "Pro" },
  { size: 5, label: "Max 5x" },
  { size: 20, label: "Max 20x" },
];

function planLabel(size: number): string {
  return PLANS.find((p) => p.size === size)?.label ?? `${size}× Pro`;
}

function Usage({ pct, resetsAt, switchAt }: { pct: number | null; resetsAt: string | null; switchAt?: number }) {
  if (pct == null) return <span className="muted">–</span>;
  const level = pct >= 100 ? "full" : switchAt != null && pct >= switchAt ? "high" : "";
  return (
    <div className="usage" title={switchAt != null ? `Runs go to the fallbacks from ${switchAt}%` : undefined}>
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
