import { db, now } from "./db.js";

export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// How a run can end that's worth a Slack alert.
export const ALERT_STATUSES = ["stuck", "error", "timeout"] as const;

export interface Settings {
  max_concurrency: number;
  default_model: string;
  default_effort: string;
  default_priority: number;
  default_timeout_min: number;
  // The primary Claude account takes every run until it has used this much (percent); then runs are
  // spread over the other accounts.
  switch_at_5h_pct: number;
  switch_at_weekly_pct: number;
  // Slack alerts, posted as Arjun. No channel means no alerts.
  alert_channel: string;
  // The console's address, for links in alerts, e.g. https://arjun.example.com.
  public_url: string;
  alert_statuses: string[];
  // Remind about a queue left paused after this many minutes, then every so many. 0 turns it off.
  alert_pause_after_min: number;
  alert_pause_every_min: number;
  // Say when no Claude account can take a run, and again when one can.
  alert_no_accounts: boolean;
}

const DEFAULTS: Settings = {
  max_concurrency: 5,
  default_model: "sonnet",
  default_effort: "high",
  default_priority: 5,
  default_timeout_min: 30,
  switch_at_5h_pct: 85,
  switch_at_weekly_pct: 95,
  alert_channel: "",
  public_url: "",
  alert_statuses: ["stuck", "error", "timeout"],
  alert_pause_after_min: 10,
  alert_pause_every_min: 10,
  alert_no_accounts: true,
};

export class ValidationError extends Error {}

export function checkInt(name: string, value: unknown, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

// Accepts the aliases or a full model name such as "claude-sonnet-5-5".
export function checkModel(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9.\-[\]]{1,80}$/i.test(value)) {
    throw new ValidationError(`model must be one of ${MODELS.join(", ")} or a full model name.`);
  }
  return value;
}

export function checkEffort(value: unknown): string {
  if (typeof value !== "string" || !(EFFORTS as readonly string[]).includes(value)) {
    throw new ValidationError(`effort must be one of ${EFFORTS.join(", ")}.`);
  }
  return value;
}

// A channel ID (C0123ABC) or name (#alerts), or "" for none.
function checkChannel(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("alert_channel must be a Slack channel ID or name.");
  const v = value.trim();
  if (v && !/^#?[a-z0-9][a-z0-9._-]{0,79}$/i.test(v)) {
    throw new ValidationError("alert_channel must be a Slack channel ID (like C0123ABC) or name (like #arjun-alerts).");
  }
  return v;
}

function checkUrl(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("public_url must be a web address.");
  const v = value.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(v)) {
    throw new ValidationError("public_url must start with https:// (or http://), e.g. https://arjun.example.com.");
  }
  return v;
}

function checkAlertStatuses(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((s) => (ALERT_STATUSES as readonly string[]).includes(s))) {
    throw new ValidationError(`alert_statuses must be a list of ${ALERT_STATUSES.join(", ")}.`);
  }
  return ALERT_STATUSES.filter((s) => value.includes(s));
}

function checkBool(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${name} must be true or false.`);
  return value;
}

const validators: { [K in keyof Settings]: (v: unknown) => Settings[K] } = {
  max_concurrency: (v) => checkInt("max_concurrency", v, 1, 20),
  default_model: checkModel,
  default_effort: checkEffort,
  default_priority: (v) => checkInt("default_priority", v, 1, 10),
  default_timeout_min: (v) => checkInt("default_timeout_min", v, 1, 24 * 60),
  switch_at_5h_pct: (v) => checkInt("switch_at_5h_pct", v, 1, 100),
  switch_at_weekly_pct: (v) => checkInt("switch_at_weekly_pct", v, 1, 100),
  alert_channel: checkChannel,
  public_url: checkUrl,
  alert_statuses: checkAlertStatuses,
  alert_pause_after_min: (v) => checkInt("alert_pause_after_min", v, 0, 24 * 60),
  alert_pause_every_min: (v) => checkInt("alert_pause_every_min", v, 0, 24 * 60),
  alert_no_accounts: (v) => checkBool("alert_no_accounts", v),
};

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (key in stored) {
      try {
        (result as Record<string, unknown>)[key] = validators[key](stored[key]);
      } catch {
        // A bad stored value falls back to the default instead of stopping the queue.
      }
    }
  }
  return result;
}

// "Pause new runs": running tasks finish, nothing new starts. Kept apart from the settings form so
// saving the form can't undo it.
export function isQueuePaused(): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'queue_paused'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) === true : false;
}

// Pausing an already paused queue keeps the time it was first paused.
export function setQueuePaused(paused: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('queue_paused', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE settings.value != excluded.value`,
  ).run(JSON.stringify(paused), now());
}

// When the queue was paused, while it is.
export function queuePausedSince(): string | null {
  const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'queue_paused'").get() as
    | { value: string; updated_at: string }
    | undefined;
  return row && JSON.parse(row.value) === true ? row.updated_at : null;
}

// State the server keeps for itself across restarts, under keys the settings form never sends.
export function getState<T>(key: string): T | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setState(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now());
}

export function updateSettings(patch: Record<string, unknown>): Settings {
  const clean: Partial<Settings> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in validators)) throw new ValidationError(`Unknown setting: ${key}`);
    (clean as Record<string, unknown>)[key] = validators[key as keyof Settings](value);
  }
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(clean)) upsert.run(key, JSON.stringify(value), now());
  })();
  return getSettings();
}
