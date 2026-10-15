import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Meta, type Task } from "../api";
import { Field } from "../components";
import { usePolling } from "../hooks";

export function NewTask() {
  const navigate = useNavigate();
  const types = usePolling(() => api<string[]>("/api/types"), 60000) ?? [];
  const [meta, setMeta] = useState<Meta | null>(null);
  const [form, setForm] = useState({
    title: "",
    prompt: "",
    type: "",
    model: "",
    effort: "",
    priority: 5,
    timeout_min: 30,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Meta>("/api/meta").then((m) => {
      setMeta(m);
      setForm((f) => ({
        ...f,
        model: m.defaults.model,
        effort: m.defaults.effort,
        priority: m.defaults.priority,
        timeout_min: m.defaults.timeout_min,
      }));
    });
  }, []);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const task = await api<Task>("/api/tasks", {
        method: "POST",
        body: { ...form, type: form.type.trim() || null, title: form.title.trim() || null },
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const models = meta ? [...new Set([...meta.models, form.model].filter(Boolean))] : [];

  return (
    <>
      <div className="page-head">
        <h1>New task</h1>
      </div>
      <form className="card form" onSubmit={submit}>
        <div className="row">
          <Field label="Title" htmlFor="title" hint="Optional. The first line of the instructions is used if empty.">
            <input id="title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={200} />
          </Field>
          <Field label="Type" htmlFor="type" hint="Optional free text, used to filter the task list.">
            <input id="type" list="type-options" value={form.type} onChange={(e) => set("type", e.target.value)} maxLength={100} />
            <datalist id="type-options">
              {types.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
        </div>

        <Field
          label="Instructions"
          htmlFor="prompt"
          hint="Nobody can answer questions during the run, so include everything Claude needs: where to work, what done looks like, where to put the result."
        >
          <textarea id="prompt" rows={12} value={form.prompt} onChange={(e) => set("prompt", e.target.value)} required />
        </Field>

        <div className="row four">
          <Field label="Model" htmlFor="model">
            <select id="model" value={form.model} onChange={(e) => set("model", e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort" htmlFor="effort">
            <select id="effort" value={form.effort} onChange={(e) => set("effort", e.target.value)}>
              {meta?.efforts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" htmlFor="priority" hint="1 is the highest.">
            <select id="priority" value={form.priority} onChange={(e) => set("priority", Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Timeout (minutes)" htmlFor="timeout">
            <input
              id="timeout"
              type="number"
              min={1}
              max={1440}
              value={form.timeout_min}
              onChange={(e) => set("timeout_min", Number(e.target.value))}
            />
          </Field>
        </div>

        {error && <div className="form-error">{error}</div>}
        <div className="actions">
          <button className="primary" disabled={busy || !form.prompt.trim() || !meta}>
            {busy ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </>
  );
}
