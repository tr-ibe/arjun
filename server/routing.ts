// Which Claude account the next run goes to. Kept free of the database so it can be tested on its own.
//
// The first account in the order is the primary. It takes every run until it reaches the switch-over
// point. After that its remaining room is held in reserve, and runs are spread over the other accounts
// by how much room each has and how soon that room would reset unused (see poolScore). The primary's
// reserve is used only when no other account has any room.

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
  // How big the plan is, as a multiple of Pro (Max 5x is 5). Usage is a percentage, so this is what
  // lets a bigger account take a bigger share.
  plan_size?: number;
  // Runs going on the account now. Its usage reading doesn't show what they'll still use.
  running?: number;
}

export interface Thresholds {
  switch_at_5h_pct: number;
  switch_at_weekly_pct: number;
}

const HOUR_MS = 3600_000;
const WEEK_HOURS = 7 * 24;
const MAX_PACE = 1.5;

// A reading only counts until its window resets.
export function currentPct(pct: number | null, resetsAt: string | null, nowMs: number): number {
  if (pct == null) return 0;
  if (resetsAt && Date.parse(resetsAt) <= nowMs) return 0;
  return pct;
}

// Can run at all: enabled, logged in, folder there, and Claude hasn't said it's out.
function canRun(a: AccountState, nowMs: number): boolean {
  return usable(a) && (!a.limited_until || Date.parse(a.limited_until) <= nowMs);
}

// Enabled and logged in, whether or not it has room right now.
function usable(a: AccountState): boolean {
  return a.enabled && a.folder_exists && !a.login_error;
}

function hasRoom(a: AccountState, nowMs: number): boolean {
  return (
    currentPct(a.five_hour_pct, a.five_hour_resets_at, nowMs) < 100 &&
    currentPct(a.seven_day_pct, a.seven_day_resets_at, nowMs) < 100
  );
}

// Some plans (Enterprise) have only the 5-hour limit, and the usage reply then has no weekly window.
// The two windows are read together, so a 5-hour reading without a weekly one means there's no weekly
// limit; no reading at all means we don't know yet.
export function hasWeeklyLimit(a: AccountState): boolean {
  return !(a.five_hour_pct != null && a.seven_day_pct == null);
}

// Hours until a window resets, or `fresh` when no window is running (the next run starts one).
function hoursLeft(resetsAt: string | null, nowMs: number, fresh: number): number {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  return at > nowMs ? (at - nowMs) / HOUR_MS : fresh;
}

// How strongly an account in the pool should get the next run. Higher is better.
//
// - The 5-hour room it has left, per hour until that room resets: room that resets soon is lost if
//   it isn't used, so 60% left with 30 minutes to go beats 80% left with 4½ hours. Anything under an
//   hour counts as an hour, so an account about to reset with a sliver left doesn't win on the sliver.
// - Times the plan size, so a Max 20x account takes about four times what a Max 5x one does.
// - Times how its week is going against an even pace: an account using its week faster than that is
//   slowed down so it doesn't run out days before the weekly reset, and one with plenty left near its
//   reset gets a little more (at most 1.5×). An account with no weekly limit gets the most: none of
//   its room is worth saving for later in the week.
// - Divided by one more than the runs already on it. Readings lag the runs, so without this a burst
//   of runs would all land on whichever account looked best a minute ago. Picking the highest score
//   each time gives each account a share of the runs in proportion to its score.
export function poolScore(a: AccountState, nowMs: number): number {
  const fiveLeft = 100 - currentPct(a.five_hour_pct, a.five_hour_resets_at, nowMs);
  const fiveRate = fiveLeft / Math.max(1, hoursLeft(a.five_hour_resets_at, nowMs, 5));
  let pace = MAX_PACE;
  if (hasWeeklyLimit(a)) {
    const weekLeft = 100 - currentPct(a.seven_day_pct, a.seven_day_resets_at, nowMs);
    const weekRate = weekLeft / Math.max(1, hoursLeft(a.seven_day_resets_at, nowMs, WEEK_HOURS));
    pace = Math.min(MAX_PACE, weekRate / (100 / WEEK_HOURS));
  }
  return (Math.max(0, fiveRate) * (a.plan_size ?? 1) * Math.max(0, pace)) / (1 + (a.running ?? 0));
}

// The primary account: the first one in the order that's turned on and logged in. A limit doesn't
// change which account is primary, so the others aren't filled one by one while it waits.
export function primaryAccount<T extends AccountState>(accounts: T[]): T | null {
  return [...accounts].sort((a, b) => a.position - b.position).find(usable) ?? null;
}

// The accounts runs are spread over once the primary is past its switch-over point, best first.
export function rankPool<T extends AccountState>(accounts: T[], nowMs = Date.now()): T[] {
  const primary = primaryAccount(accounts);
  return accounts
    .filter((a) => a !== primary && canRun(a, nowMs) && hasRoom(a, nowMs))
    .map((a) => ({ a, score: poolScore(a, nowMs) }))
    .sort((x, y) => y.score - x.score || x.a.position - y.a.position)
    .map((x) => x.a);
}

export function primaryUnderSwitchOver(a: AccountState, t: Thresholds, nowMs: number): boolean {
  return (
    currentPct(a.five_hour_pct, a.five_hour_resets_at, nowMs) < t.switch_at_5h_pct &&
    currentPct(a.seven_day_pct, a.seven_day_resets_at, nowMs) < t.switch_at_weekly_pct
  );
}

export function chooseAccount<T extends AccountState>(accounts: T[], t: Thresholds, nowMs = Date.now()): T | null {
  const primary = primaryAccount(accounts);
  const primaryReady = !!primary && canRun(primary, nowMs);
  if (primary && primaryReady && primaryUnderSwitchOver(primary, t, nowMs)) return primary;
  const best = rankPool(accounts, nowMs)[0];
  if (best) return best;
  return primary && primaryReady && hasRoom(primary, nowMs) ? primary : null;
}

// Plan size from the rate-limit tier Claude Code saves with the login, e.g. "default_claude_max_5x".
// Team and Enterprise premium seats have the Max 5x tier too; standard seats count as Pro.
export function planSizeFromTier(tier: string | null | undefined): number | null {
  if (!tier) return null;
  const max = /max_(\d+)x/i.exec(tier);
  if (max) return Number(max[1]);
  return /max/i.test(tier) ? 5 : 1;
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
