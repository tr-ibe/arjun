// Which Claude account the next run goes to. Kept free of the database so it can be tested on its own.
//
// Accounts are tried in their order: the first one is used until it reaches the switch-over point,
// then the second, then the third, and so on. When every account is past that point, the first one
// that still has room is used, so the last few percent aren't wasted while work is waiting.

export interface AccountState {
  id: number;
  name: string;
  position: number;
  enabled: boolean;
  folder_exists: boolean;
  login_error: string | null;
  limited_until: string | null;
  five_hour_pct: number | null;
  five_hour_resets_at: string | null;
  seven_day_pct: number | null;
  seven_day_resets_at: string | null;
}

export interface Thresholds {
  switch_at_5h_pct: number;
  switch_at_weekly_pct: number;
}

// A reading only counts until its window resets.
export function currentPct(pct: number | null, resetsAt: string | null, nowMs: number): number {
  if (pct == null) return 0;
  if (resetsAt && Date.parse(resetsAt) <= nowMs) return 0;
  return pct;
}

// Can run at all: enabled, logged in, folder there, and Claude hasn't said it's out.
function canRun(a: AccountState, nowMs: number): boolean {
  if (!a.enabled || !a.folder_exists || a.login_error) return false;
  return !a.limited_until || Date.parse(a.limited_until) <= nowMs;
}

export function chooseAccount<T extends AccountState>(accounts: T[], t: Thresholds, nowMs = Date.now()): T | null {
  const ready = accounts.filter((a) => canRun(a, nowMs)).sort((a, b) => a.position - b.position);
  const fiveHour = (a: T) => currentPct(a.five_hour_pct, a.five_hour_resets_at, nowMs);
  const weekly = (a: T) => currentPct(a.seven_day_pct, a.seven_day_resets_at, nowMs);
  return (
    ready.find((a) => fiveHour(a) < t.switch_at_5h_pct && weekly(a) < t.switch_at_weekly_pct) ??
    ready.find((a) => fiveHour(a) < 100 && weekly(a) < 100) ??
    null
  );
}

// When no account can take a run: the earliest moment one is expected to free up, or null if
// none will on its own (all disabled, or all need a new login).
export function nextFreeAt(accounts: AccountState[], nowMs = Date.now()): string | null {
  let best: number | null = null;
  for (const a of accounts) {
    if (!a.enabled || !a.folder_exists || a.login_error) continue;
    const waits = [a.limited_until];
    if (currentPct(a.five_hour_pct, a.five_hour_resets_at, nowMs) >= 100) waits.push(a.five_hour_resets_at);
    if (currentPct(a.seven_day_pct, a.seven_day_resets_at, nowMs) >= 100) waits.push(a.seven_day_resets_at);
    const times = waits.filter((w): w is string => !!w).map(Date.parse).filter((ms) => ms > nowMs);
    if (times.length === 0) continue;
    const at = Math.max(...times);
    if (best === null || at < best) best = at;
  }
  return best === null ? null : new Date(best).toISOString();
}

// ---- Reading Claude's usage ----

export interface Usage {
  five_hour_pct: number | null;
  five_hour_resets_at: string | null;
  seven_day_pct: number | null;
  seven_day_resets_at: string | null;
}

// The reply from /api/oauth/usage, the endpoint Claude Code's /usage reads. It isn't documented, so
// read it loosely: the known shape is { five_hour: { utilization, resets_at }, seven_day: {…} },
// and a `limits` list of windows is accepted too in case it moves there.
export function parseUsage(body: unknown): Usage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  let fiveHour = readWindow(b.five_hour);
  let weekly = readWindow(b.seven_day);
  if (Array.isArray(b.limits)) {
    for (const item of b.limits) {
      const label = JSON.stringify([item?.kind, item?.name, item?.window, item?.type]).toLowerCase();
      if (/model|opus|sonnet|fable|haiku/.test(label)) continue;
      if (!fiveHour && /5|five|session/.test(label)) fiveHour = readWindow(item);
      else if (!weekly && /week|seven|7/.test(label)) weekly = readWindow(item);
    }
  }
  if (!fiveHour && !weekly) return null;
  return {
    five_hour_pct: fiveHour?.pct ?? null,
    five_hour_resets_at: fiveHour?.resetsAt ?? null,
    seven_day_pct: weekly?.pct ?? null,
    seven_day_resets_at: weekly?.resetsAt ?? null,
  };
}

function readWindow(w: unknown): { pct: number | null; resetsAt: string | null } | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  const pct = [o.utilization, o.percent, o.used_pct, o.used_percentage].find((v) => typeof v === "number") as
    | number
    | undefined;
  const reset = o.resets_at ?? o.reset_at ?? o.resetsAt;
  let resetsAt: string | null = null;
  if (typeof reset === "string" && !Number.isNaN(Date.parse(reset))) resetsAt = new Date(reset).toISOString();
  if (typeof reset === "number") resetsAt = new Date(reset < 1e12 ? reset * 1000 : reset).toISOString();
  if (pct === undefined && !resetsAt) return null;
  return { pct: pct ?? null, resetsAt };
}

// Claude Code's messages when an account's login no longer works.
const LOGIN_RE = /please run \/login|invalid api key|oauth token (has expired|has been revoked|revoked)|authentication_error/i;

export function detectLoginFailure(output: string): boolean {
  return LOGIN_RE.test(output);
}
