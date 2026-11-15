import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, retryTasks, type ApiKey, type RetryResult, type TaskListItem } from "../api";
import { StatusPill } from "../components";
import { duration, STATUS_LABEL, timeAgo } from "../format";
import { usePolling, useReloadable } from "../hooks";

const STATUSES = Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[];
const PAGE = 50;

export function Tasks() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const status = params.get("status") ?? "";
  const type = params.get("type") ?? "";
  const source = params.get("source") ?? "";
  const q = params.get("q") ?? "";

  const query = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) });
  if (status) query.set("status", status);
  if (type) query.set("type", type);
  if (source) query.set("source", source);
  if (q) query.set("q", q);

  const { data, error, reload } = useReloadable(
    () => api<{ items: TaskListItem[]; has_more: boolean; total: number }>(`/api/tasks?${query}`),
    5000,
    [query.toString()],
    { keepData: true },
  );
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));

  // A page past the end (tasks were deleted, or an old link) goes to the last one.
  useEffect(() => {
    if (data && page > pages) goTo(pages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, page, pages]);

  function goTo(n: number) {
    const next = new URLSearchParams(params);
    if (n > 1) next.set("page", String(n));
    else next.delete("page");
    setParams(next);
    window.scrollTo({ top: 0 });
  }
  // Failed tasks ticked for retrying together. Only ones still retryable on this page count, so a
  // task that was retried elsewhere (or scrolled off by a filter) quietly drops out.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [outcome, setOutcome] = useState<{ result?: RetryResult; error?: string } | null>(null);
  const retryable = (data?.items ?? []).filter((t) => t.can_retry).map((t) => t.id);
  const chosen = retryable.filter((id) => selected.has(id));
  const allChosen = retryable.length > 0 && chosen.length === retryable.length;
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = chosen.length > 0 && !allChosen;
  });

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function retryChosen() {
    setRetrying(true);
    setOutcome(null);
    try {
      const result = await retryTasks(chosen);
      setOutcome({ result });
      setSelected(new Set());
      void reload();
    } catch (e) {
      setOutcome({ error: (e as Error).message });
    } finally {
      setRetrying(false);
    }
  }

  const types = usePolling(() => api<string[]>("/api/types"), 30000) ?? [];
  const keys = usePolling(() => api<ApiKey[]>("/api/keys"), 60000) ?? [];

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("page"); // new filters start from the first page
    setParams(next, { replace: true });
  }

  return (
    <>
      <div className="page-head">
        <h1>Tasks</h1>
        <Link className="button primary" to="/new">
          New task
        </Link>
      </div>

      <div className="filters">
        <input
          id="filter-q"
          type="search"
          placeholder="Search title or instructions"
          defaultValue={q}
          onKeyDown={(e) => e.key === "Enter" && setFilter("q", e.currentTarget.value)}
          onBlur={(e) => e.currentTarget.value !== q && setFilter("q", e.currentTarget.value)}
        />
        <select id="filter-status" value={status} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select id="filter-type" value={type} onChange={(e) => setFilter("type", e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select id="filter-source" value={source} onChange={(e) => setFilter("source", e.target.value)}>
          <option value="">All sources</option>
          <option value="ui">UI</option>
          <option value="slack">Slack</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="banner bad">{error}</div>}

      {retryable.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Retry failed tasks">
          {chosen.length > 0 ? (
            <>
              <span>
                {chosen.length} failed {chosen.length === 1 ? "task" : "tasks"} selected
              </span>
              <button className="primary" onClick={retryChosen} disabled={retrying}>
                {retrying ? "Queuing…" : `Retry ${chosen.length}`}
              </button>
              <button className="link" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <span className="muted">Each continues where it left off with “Try again.”</span>
            </>
          ) : (
            <>
              <span>
                {retryable.length} failed {retryable.length === 1 ? "task" : "tasks"} on this page
              </span>
              <button className="secondary" onClick={() => setSelected(new Set(retryable))}>
                Select all failed
              </button>
              <span className="muted">or tick the ones to retry.</span>
            </>
          )}
        </div>
      )}
      {outcome?.error && <div className="form-error bulk-note">{outcome.error}</div>}
      {outcome?.result && (
        <div className={`${outcome.result.skipped.length ? "form-error" : "form-ok"} bulk-note`}>
          {outcome.result.retried.length > 0 &&
            `Queued ${outcome.result.retried.length} ${outcome.result.retried.length === 1 ? "retry" : "retries"}. `}
          {outcome.result.skipped.length > 0 &&
            `Skipped ${outcome.result.skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}`}
          <button className="link dismiss" onClick={() => setOutcome(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="table-wrap">
        <table className="tasks">
          <thead>
            <tr>
              <th className="select-col">
                <label className="select-hit">
                  <input
                    ref={headBox}
                    type="checkbox"
                    aria-label="Select all failed tasks on this page"
                    title={retryable.length ? "Select all failed tasks on this page" : "No failed tasks on this page"}
                    disabled={retryable.length === 0}
                    checked={allChosen}
                    onChange={() => setSelected(allChosen ? new Set() : new Set(retryable))}
                  />
                </label>
              </th>
              <th>Status</th>
              <th>Task</th>
              <th>Type</th>
              <th>Source</th>
              <th className="num">Priority</th>
              <th>Created</th>
              <th className="num">Duration</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((t) => (
              <tr key={t.id} className={selected.has(t.id) && t.can_retry ? "selected" : undefined}>
                <td className="select-col">
                  {t.can_retry && (
                    <label className="select-hit">
                      <input
                        type="checkbox"
                        aria-label={`Select ${t.title} to retry`}
                        checked={selected.has(t.id)}
                        onChange={() => toggle(t.id)}
                      />
                    </label>
                  )}
                </td>
                <td>
                  <StatusPill status={t.latest_run.status} />
                  {t.latest_run.queue_position && (
                    <div className="sub mono">#{t.latest_run.queue_position} in line</div>
                  )}
                </td>
                <td className="task-cell">
                  <Link to={`/tasks/${t.id}`} className="task-title">
                    {t.title}
                  </Link>
                  <div className="sub clamp">
                    {t.latest_run.summary ?? t.latest_run.error ?? (t.latest_run.attempt > 1 ? `Attempt ${t.latest_run.attempt}` : "")}
                  </div>
                </td>
                <td>{t.type ? <span className="tag">{t.type}</span> : <span className="muted">–</span>}</td>
                <td>{t.source_label}</td>
                <td className="num mono">{t.priority}</td>
                <td title={t.created_at}>{timeAgo(t.created_at)}</td>
                <td className="num mono">{duration(t.latest_run.started_at, t.latest_run.ended_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.items.length === 0 && (
          <div className="empty">
            {status || type || source || q ? (
              "No tasks match these filters."
            ) : (
              <>
                No tasks yet. <Link to="/new">Create the first one</Link>, or send one through the API with a key.
              </>
            )}
          </div>
        )}
      </div>
      {data && data.total > PAGE && (
        <nav className="pagination" aria-label="Pages">
          <button className="secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>
            ← Newer
          </button>
          <span className="muted">
            {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, data.total)} of {data.total} · Page {page} of {pages}
          </span>
          <button className="secondary" disabled={page >= pages} onClick={() => goTo(page + 1)}>
            Older →
          </button>
        </nav>
      )}
    </>
  );
}
