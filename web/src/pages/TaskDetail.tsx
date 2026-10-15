import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Run, type Task, type TimelineEntry } from "../api";
import { StatusPill } from "../components";
import { ACTIVE, clock, duration, timeOnly } from "../format";
import { useReloadable } from "../hooks";

export function TaskDetail() {
  const { id } = useParams();
  const [fast, setFast] = useState(true);
  const task = useReloadable(() => api<Task>(`/api/tasks/${id}`), fast ? 3000 : 15000, [id]);
  const timeline = useReloadable(
    () => api<{ entries: TimelineEntry[]; missing: boolean }>(`/api/tasks/${id}/timeline`),
    fast ? 5000 : null,
    [id],
  );

  const t = task.data;
  const latest = t?.latest_run;
  const active = latest ? ACTIVE.includes(latest.status) : false;
  if (t && fast !== active) setFast(active);

  if (task.error && !t) return <div className="banner bad">{task.error}</div>;
  if (!t || !latest) return <div className="muted">Loading…</div>;

  const reloadAll = () => {
    void task.reload();
    void timeline.reload();
  };

  return (
    <>
      <div className="crumbs">
        <Link to="/">Tasks</Link> / #{t.id}
      </div>
      <div className="page-head">
        <h1>{t.title}</h1>
        <StatusPill status={latest.status} />
      </div>
      <div className="meta-line">
        {t.type && <span className="tag">{t.type}</span>}
        <span>From {t.source_label}</span>
        <span>Priority {t.priority}</span>
        <span>
          {t.model} · {t.effort} effort
        </span>
        <span title={t.created_at}>Created {clock(t.created_at)}</span>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <LatestCard run={latest} onChanged={reloadAll} />
          <ContinueForm task={t} onContinued={reloadAll} />
          <Timeline entries={timeline.data?.entries ?? null} missing={timeline.data?.missing ?? false} />
        </div>
        <aside className="detail-side">
          <section className="card">
            <h2>Instructions</h2>
            <Collapsible text={t.prompt} lines={8} />
          </section>
          <section className="card">
            <h2>Attempts</h2>
            <ol className="attempts">
              {[...t.runs].reverse().map((r) => (
                <Attempt key={r.id} run={r} />
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}

function LatestCard({ run, onChanged }: { run: Run; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCancel = ACTIVE.includes(run.status);

  async function cancel() {
    try {
      await api(`/api/runs/${run.id}/cancel`, { method: "POST" });
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className={`card latest status-${run.status}`}>
      <div className="latest-head">
        <h2>
          Attempt {run.attempt}
          {run.queue_position ? <span className="muted"> · #{run.queue_position} in line</span> : null}
        </h2>
        <span className="muted mono">
          {run.started_at ? duration(run.started_at, run.ended_at) : "not started"}
          {" · "}timeout {run.timeout_min} min
        </span>
      </div>
      {run.status === "queued" && !run.summary && (
        <p className="muted">
          {run.resumed_from_run_id
            ? "Waiting for a free slot (and for the previous attempt to finish)."
            : "Waiting for a free slot."}
        </p>
      )}
      {run.status === "running" && <p className="muted">Claude is working on it. The timeline below updates every few seconds.</p>}
      {run.summary && <p className="summary">{run.summary}</p>}
      {run.error && run.error !== run.summary && <pre className="error-text">{run.error}</pre>}
      {run.status === "limited" && run.resets_at && (
        <p className="muted">A continue is queued and starts after {clock(run.resets_at)}.</p>
      )}
      {canCancel && (
        <div className="actions">
          {confirming ? (
            <>
              <span>Stop this run?</span>
              <button className="danger" onClick={cancel}>
                Yes, cancel it
              </button>
              <button className="secondary" onClick={() => setConfirming(false)}>
                Keep running
              </button>
            </>
          ) : (
            <button className="secondary" onClick={() => setConfirming(true)}>
              Cancel run
            </button>
          )}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
    </section>
  );
}

function ContinueForm({ task, onContinued }: { task: Task; onContinued: () => void }) {
  const [message, setMessage] = useState("");
  const [timeout, setTimeoutMin] = useState(task.latest_run.timeout_min);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = ACTIVE.includes(task.latest_run.status);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/tasks/${task.id}/continue`, { method: "POST", body: { message, timeout_min: timeout } });
      setMessage("");
      onContinued();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card continue" onSubmit={submit}>
      <h2>Continue</h2>
      <p className="muted">
        Claude picks up the same session and folder, with everything it did so far, plus these new instructions.
        {waiting && " It starts after the current attempt ends."}
      </p>
      <textarea
        id="continue-message"
        rows={4}
        placeholder="e.g. Use the staging API key in ~/.config/mytribe and try again."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="actions">
        <label htmlFor="continue-timeout" className="inline-label">
          Timeout (minutes)
        </label>
        <input
          id="continue-timeout"
          className="narrow"
          type="number"
          min={1}
          max={1440}
          value={timeout}
          onChange={(e) => setTimeoutMin(Number(e.target.value))}
        />
        <button className="primary" disabled={busy || !message.trim()}>
          {busy ? "Queuing…" : "Continue"}
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}

function Attempt({ run }: { run: Run }) {
  return (
    <li className="attempt">
      <div className="attempt-head">
        <span className="mono">#{run.attempt}</span>
        <StatusPill status={run.status} />
        <span className="muted mono">{duration(run.started_at, run.ended_at)}</span>
      </div>
      {run.attempt > 1 && <Collapsible text={run.instructions} lines={3} />}
      {(run.summary || run.error) && <div className="sub">{run.summary ?? run.error}</div>}
      <div className="sub muted">{clock(run.started_at ?? run.created_at)}</div>
    </li>
  );
}

function Collapsible({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 120;
  return (
    <div className="collapsible">
      <div className={`pre-text ${open || !long ? "" : "clamped"}`} style={{ ["--lines" as string]: lines }}>
        {text}
      </div>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

// ---- Timeline ----

function toolSummary(tool: string | undefined, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query ?? i.description;
  if (typeof pick === "string") return pick.split("\n")[0].slice(0, 160);
  const first = Object.values(i).find((v) => typeof v === "string") as string | undefined;
  return first ? first.split("\n")[0].slice(0, 160) : "";
}

function Timeline({ entries, missing }: { entries: TimelineEntry[] | null; missing: boolean }) {
  if (!entries) return <section className="card timeline"><h2>Timeline</h2><p className="muted">Loading…</p></section>;

  const results = new Map(entries.filter((e) => e.kind === "tool_result").map((e) => [e.tool_use_id, e]));

  return (
    <section className="card timeline">
      <h2>Timeline</h2>
      {missing && (
        <p className="muted">
          Part of the history isn't available. Claude keeps session files for 60 days, and a run that never started has none.
        </p>
      )}
      {entries.length === 0 && !missing && <p className="muted">Nothing yet. Steps appear here once Claude starts.</p>}
      <ol className="steps">
        {entries.map((e, i) => {
          if (e.kind === "tool_result") return null;
          if (e.kind === "tool_use") {
            const result = results.get(e.tool_use_id);
            return (
              <li key={i} className={`step tool ${result?.is_error ? "is-error" : ""}`}>
                <details>
                  <summary>
                    <span className="time mono">{timeOnly(e.at)}</span>
                    <span className="tool-name">{e.tool}</span>
                    <span className="tool-arg mono">{toolSummary(e.tool, e.input)}</span>
                    {!result && <span className="muted"> · running</span>}
                  </summary>
                  <div className="tool-body">
                    <div className="label">Input</div>
                    <pre>{JSON.stringify(e.input, null, 2)}</pre>
                    {result && (
                      <>
                        <div className="label">{result.is_error ? "Error" : "Result"}</div>
                        <pre>{result.text || "(empty)"}</pre>
                      </>
                    )}
                  </div>
                </details>
              </li>
            );
          }
          if (e.kind === "thinking") {
            return (
              <li key={i} className="step thinking">
                <details>
                  <summary>
                    <span className="time mono">{timeOnly(e.at)}</span> Thinking
                  </summary>
                  <div className="pre-text">{e.text}</div>
                </details>
              </li>
            );
          }
          if (e.kind === "prompt") {
            return (
              <li key={i} className="step prompt">
                <div className="step-head">
                  <span className="time mono">{timeOnly(e.at)}</span> Prompt sent to Claude
                </div>
                <Collapsible text={e.text ?? ""} lines={4} />
              </li>
            );
          }
          return (
            <li key={i} className="step text">
              <div className="step-head">
                <span className="time mono">{timeOnly(e.at)}</span> Claude
              </div>
              <div className="pre-text">{e.text}</div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
