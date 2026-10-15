import { useEffect, useState, type FormEvent } from "react";
import { api, type Settings } from "../api";
import { Field } from "../components";

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
      <form className="card form" onSubmit={save}>
        <h2>Queue</h2>
        <Field
          label="Max runs at once"
          htmlFor="max_concurrency"
          hint="All tasks share one Max plan, so more at once reaches its usage limit sooner. Lowering it never stops running tasks."
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
