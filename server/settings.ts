import { db, now } from "./db.js";

export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface Settings {
  max_concurrency: number;
  default_model: string;
  default_effort: string;
  default_priority: number;
  default_timeout_min: number;
  // Move on to the next Claude account once this one has used this much (percent).
  switch_at_5h_pct: number;
  switch_at_weekly_pct: number;
}

const DEFAULTS: Settings = {
  max_concurrency: 5,
  default_model: "sonnet",
  default_effort: "high",
  default_priority: 5,
  default_timeout_min: 30,
  switch_at_5h_pct: 85,
  switch_at_weekly_pct: 95,
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

const validators: { [K in keyof Settings]: (v: unknown) => Settings[K] } = {
  max_concurrency: (v) => checkInt("max_concurrency", v, 1, 20),
  default_model: checkModel,
  default_effort: checkEffort,
  default_priority: (v) => checkInt("default_priority", v, 1, 10),
  default_timeout_min: (v) => checkInt("default_timeout_min", v, 1, 24 * 60),
  switch_at_5h_pct: (v) => checkInt("switch_at_5h_pct", v, 1, 100),
  switch_at_weekly_pct: (v) => checkInt("switch_at_weekly_pct", v, 1, 100),
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

export function setQueuePaused(paused: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('queue_paused', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(paused), now());
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
