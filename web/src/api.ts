export type RunStatus = "queued" | "running" | "done" | "stuck" | "error" | "timeout" | "limited" | "cancelled";

export interface Run {
  id: number;
  task_id: number;
  attempt: number;
  status: RunStatus;
  instructions: string;
  timeout_min: number;
  resumed_from_run_id: number | null;
  session_id: string | null;
  run_dir: string | null;
  summary: string | null;
  error: string | null;
  exit_code: number | null;
  resets_at: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  queue_position: number | null;
}

export interface Task {
  id: number;
  title: string;
  prompt: string;
  type: string | null;
  priority: number;
  model: string;
  effort: string;
  source: "ui" | "api";
  source_label: string;
  created_at: string;
  latest_run: Run;
  runs: Run[];
}

export interface TaskListItem {
  id: number;
  title: string;
  type: string | null;
  priority: number;
  model: string;
  effort: string;
  created_at: string;
  source_label: string;
  latest_run: Pick<
    Run,
    "id" | "attempt" | "status" | "summary" | "error" | "created_at" | "started_at" | "ended_at" | "resets_at" | "queue_position"
  >;
}

export interface TimelineEntry {
  at: string | null;
  kind: "prompt" | "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  tool?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

export interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface Settings {
  max_concurrency: number;
  default_model: string;
  default_effort: string;
  default_priority: number;
  default_timeout_min: number;
}

export interface Meta {
  models: string[];
  efforts: string[];
  defaults: { model: string; effort: string; priority: number; timeout_min: number };
}

export interface QueueStatus {
  running: number;
  queued: number;
  max_concurrency: number;
  paused_until: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    // Every change is sent as JSON; the server rejects anything else from the browser.
    headers: method === "GET" ? {} : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/auth/login") onUnauthorized();
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}
