import type { FastifyInstance } from "fastify";
import { db, getRun, getTask, insertRun, insertTask, latestRun, now, runsForTask, updateRun, type RunRow, type TaskRow } from "../db.js";
import { kick, queuePaused, queuePositions } from "../dispatcher.js";
import { activeCount, isActive, stopRun } from "../runner.js";
import { checkEffort, checkInt, checkModel, getSettings, isQueuePaused, setQueuePaused, ValidationError } from "../settings.js";
import { readTimeline } from "../timeline.js";

function text(name: string, value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${name} is required.`);
  if (value.length > max) throw new ValidationError(`${name} can be at most ${max} characters.`);
  return value.trim();
}

function optionalText(name: string, value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  return text(name, value, max);
}

function idParam(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError("Invalid id.");
  return id;
}

function sourceLabel(task: TaskRow): string {
  if (task.source === "ui") return "UI";
  if (task.source === "slack") return "Slack";
  const key = db.prepare("SELECT name FROM api_keys WHERE id = ?").get(task.api_key_id) as { name: string } | undefined;
  return key?.name ?? "API";
}

function runView(run: RunRow, positions: Map<number, number>) {
  const { pid: _pid, ...rest } = run;
  const account = run.account_id
    ? (db.prepare("SELECT name FROM accounts WHERE id = ?").get(run.account_id) as { name: string } | undefined)
    : undefined;
  return { ...rest, account_name: account?.name ?? null, queue_position: positions.get(run.id) ?? null };
}

function taskView(taskId: number) {
  const task = getTask(taskId)!;
  const positions = queuePositions();
  const runs = runsForTask(taskId).map((r) => runView(r, positions));
  const slack = db.prepare("SELECT permalink FROM slack_threads WHERE task_id = ?").get(taskId) as
    | { permalink: string | null }
    | undefined;
  return {
    ...task,
    source_label: sourceLabel(task),
    slack_url: slack?.permalink ?? null,
    latest_run: runs[runs.length - 1],
    runs,
  };
}

export async function taskRoutes(app: FastifyInstance) {
  app.post("/api/tasks", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = getSettings();
    const prompt = text("prompt", body.prompt, 100_000);
    const title = optionalText("title", body.title, 200) ?? prompt.split("\n")[0].slice(0, 80);
    const type = optionalText("type", body.type, 100);
    const priority = body.priority == null ? s.default_priority : checkInt("priority", body.priority, 1, 10);
    const model = body.model == null || body.model === "" ? s.default_model : checkModel(body.model);
    const effort = body.effort == null || body.effort === "" ? s.default_effort : checkEffort(body.effort);
    const timeout =
      body.timeout_min == null ? s.default_timeout_min : checkInt("timeout_min", body.timeout_min, 1, 24 * 60);

    const caller = req.caller!;
    const taskId = insertTask({
      title,
      prompt,
      type,
      priority,
      model,
      effort,
      source: caller.kind,
      api_key_id: caller.kind === "api" ? caller.keyId : null,
      timeout_min: timeout,
    });

    kick();
    return reply.code(201).send(taskView(taskId));
  });

  app.get("/api/tasks", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? checkInt("limit", q.limit, 1, 200) : 50;
    const offset = q.offset ? checkInt("offset", q.offset, 0, 1_000_000) : 0;
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.status) {
      where.push("r.status = @status");
      params.status = q.status;
    }
    if (q.type) {
      where.push("t.type = @type");
      params.type = q.type;
    }
    if (q.source === "ui" || q.source === "slack") {
      where.push("t.source = @source");
      params.source = q.source;
    } else if (q.source) {
      where.push("t.api_key_id = @key");
      params.key = Number(q.source);
    }
    if (q.q) {
      where.push("(t.title LIKE @q OR t.prompt LIKE @q)");
      params.q = `%${q.q}%`;
    }

    // Each task with its latest attempt, which is what the status filter looks at.
    const from = `FROM tasks t
           JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id = t.id ORDER BY attempt DESC LIMIT 1)
           LEFT JOIN api_keys k ON k.id = t.api_key_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(params) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT t.*, k.name AS key_name,
                r.id AS run_id, r.attempt, r.status, r.summary, r.error,
                r.created_at AS run_created_at, r.started_at, r.ended_at, r.resets_at
           ${from}
          ORDER BY t.id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: limit + 1, offset }) as (TaskRow & Record<string, unknown>)[];

    const positions = queuePositions();
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      priority: row.priority,
      model: row.model,
      effort: row.effort,
      created_at: row.created_at,
      source_label:
        row.source === "ui" ? "UI" : row.source === "slack" ? "Slack" : ((row.key_name as string | null) ?? "API"),
      latest_run: {
        id: row.run_id,
        attempt: row.attempt,
        status: row.status,
        summary: row.summary,
        error: row.error,
        created_at: row.run_created_at,
        started_at: row.started_at,
        ended_at: row.ended_at,
        resets_at: row.resets_at,
        queue_position: positions.get(row.run_id as number) ?? null,
      },
    }));
    return { items, has_more: rows.length > limit, total };
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (!getTask(id)) return reply.code(404).send({ error: "Task not found." });
    return taskView(id);
  });

  app.post("/api/tasks/:id/continue", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (!getTask(id)) return reply.code(404).send({ error: "Task not found." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = text("message", body.message, 100_000);
    const previous = latestRun(id)!;
    const timeout =
      body.timeout_min == null ? previous.timeout_min : checkInt("timeout_min", body.timeout_min, 1, 24 * 60);
    insertRun({ task_id: id, instructions: message, timeout_min: timeout, resumed_from_run_id: previous.id });
    kick();
    return reply.code(201).send(taskView(id));
  });

  app.get("/api/tasks/:id/timeline", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (!getTask(id)) return reply.code(404).send({ error: "Task not found." });
    // Continues resume the same session, so usually there's one session per task.
    const sessionIds = [...new Set(runsForTask(id).map((r) => r.session_id).filter((s): s is string => !!s))];
    const entries = [];
    let missing = false;
    for (const sid of sessionIds) {
      const part = readTimeline(sid);
      if (part) entries.push(...part);
      else missing = true;
    }
    return { entries, missing };
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    const run = getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found." });
    if (run.status === "queued") {
      updateRun(id, { status: "cancelled", ended_at: now() });
      kick();
    } else if (isActive(id)) {
      if (run.status === "running") updateRun(id, { status: "cancelled" });
      stopRun(id, "cancel");
    } else {
      return reply.code(409).send({ error: "This run has already finished." });
    }
    return taskView(run.task_id);
  });

  app.get("/api/types", async () => {
    const rows = db.prepare("SELECT DISTINCT type FROM tasks WHERE type IS NOT NULL ORDER BY type").all() as {
      type: string;
    }[];
    return rows.map((r) => r.type);
  });

  // Pause or resume starting new runs. Running ones always finish.
  app.post("/api/queue", async (req) => {
    const { paused } = (req.body ?? {}) as { paused?: unknown };
    if (typeof paused !== "boolean") throw new ValidationError("paused must be true or false.");
    setQueuePaused(paused);
    kick();
    return { queue_paused: paused, running: activeCount() };
  });

  app.get("/api/status", async () => {
    const queued = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").get() as { n: number }).n;
    const paused = queuePaused();
    return {
      running: activeCount(),
      queued,
      max_concurrency: getSettings().max_concurrency,
      queue_paused: isQueuePaused(),
      paused_until: paused?.until ?? null,
      paused_reason: paused?.reason ?? null,
    };
  });
}
