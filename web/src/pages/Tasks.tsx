import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ApiKey, type TaskListItem } from "../api";
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

  const { data, error } = useReloadable(
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

      <div className="table-wrap">
        <table className="tasks">
          <thead>
            <tr>
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
              <tr key={t.id}>
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
