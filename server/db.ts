import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export type RunStatus =
  | "queued"
  | "running"
  | "done"
  | "stuck"
  | "error"
  | "timeout"
  | "limited"
  | "cancelled";

export interface TaskRow {
  id: number;
  title: string;
  prompt: string;
  type: string | null;
  priority: number;
  model: string;
  effort: string;
  source: "ui" | "api";
  api_key_id: number | null;
  created_at: string;
}

export interface RunRow {
  id: number;
  task_id: number;
  attempt: number;
  status: RunStatus;
  instructions: string;
  timeout_min: number;
  resumed_from_run_id: number | null;
  session_id: string | null;
  run_dir: string | null;
  pid: number | null;
  summary: string | null;
  error: string | null;
  exit_code: number | null;
  resets_at: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(join(config.dataDir, "arjun.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    type       TEXT,
    priority   INTEGER NOT NULL,
    model      TEXT NOT NULL,
    effort     TEXT NOT NULL,
    source     TEXT NOT NULL,
    api_key_id INTEGER REFERENCES api_keys(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id                  INTEGER PRIMARY KEY,
    task_id             INTEGER NOT NULL REFERENCES tasks(id),
    attempt             INTEGER NOT NULL,
    status              TEXT NOT NULL,
    instructions        TEXT NOT NULL,
    timeout_min         REAL NOT NULL,
    resumed_from_run_id INTEGER REFERENCES runs(id),
    session_id          TEXT,
    run_dir             TEXT,
    pid                 INTEGER,
    summary             TEXT,
    error               TEXT,
    exit_code           INTEGER,
    resets_at           TEXT,
    created_at          TEXT NOT NULL,
    started_at          TEXT,
    ended_at            TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
  CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS tasks_type ON tasks(type);
`);

export const now = () => new Date().toISOString();

export function getTask(id: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
}

export function getRun(id: number): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function runsForTask(taskId: number): RunRow[] {
  return db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY attempt").all(taskId) as RunRow[];
}

export function latestRun(taskId: number): RunRow | undefined {
  return db
    .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1")
    .get(taskId) as RunRow | undefined;
}

export function updateRun(id: number, fields: Partial<RunRow>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE runs SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

export function insertRun(fields: {
  task_id: number;
  instructions: string;
  timeout_min: number;
  resumed_from_run_id?: number | null;
}): RunRow {
  const attempt =
    ((db.prepare("SELECT MAX(attempt) AS n FROM runs WHERE task_id = ?").get(fields.task_id) as { n: number | null })
      .n ?? 0) + 1;
  const info = db
    .prepare(
      `INSERT INTO runs (task_id, attempt, status, instructions, timeout_min, resumed_from_run_id, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .run(fields.task_id, attempt, fields.instructions, fields.timeout_min, fields.resumed_from_run_id ?? null, now());
  return getRun(Number(info.lastInsertRowid))!;
}
