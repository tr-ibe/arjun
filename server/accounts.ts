import type { FastifyBaseLogger } from "fastify";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prepareAccountDir, readLogin } from "./account_dir.js";
import { config } from "./config.js";
import { db, now, type AccountRow } from "./db.js";
import {
  chooseAccount,
  currentPct,
  nextFreeAt,
  hasWeeklyLimit,
  parseUsage,
  planSizeFromTier,
  poolScore,
  primaryAccount,
  primaryUnderSwitchOver,
  rankPool,
  type AccountState,
} from "./routing.js";
import { getSettings, ValidationError } from "./settings.js";

const CHECK_EVERY_MS = 60_000;
// The usage endpoint rate-limits, so each account is read only as often as routing needs it: the
// account new runs go to and accounts with runs on them every few minutes, the rest now and then.
const ACTIVE_CHECK_EVERY_MS = 3 * 60_000;
const IDLE_CHECK_EVERY_MS = 15 * 60_000;
// A run ending reads its account again, unless it was read this recently.
const MIN_CHECK_GAP_MS = 60_000;
// After a "rate limited" reply, leave the account alone for this long, doubling up to the cap.
const BACKOFF_FIRST_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export const isMain = (a: { config_dir: string }) => a.config_dir === config.claudeConfigDir;

export function listAccounts(): AccountRow[] {
  // Main first, then the fallbacks in the order they were added.
  return db
    .prepare("SELECT * FROM accounts ORDER BY config_dir = ? DESC, position, id")
    .all(config.claudeConfigDir) as AccountRow[];
}

export function getAccount(id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

function updateAccount(id: number, fields: Partial<AccountRow>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE accounts SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

const insertAccount = db.prepare(`
  INSERT INTO accounts (name, config_dir, position, created_at)
  VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM accounts), ?)
  ON CONFLICT DO NOTHING
`);

// The main account is Claude's usual folder. Extra ones are the folders in accountsDir, added at the
// end of the order once they have a login (the add-account command makes them).
export function syncAccounts(): void {
  insertAccount.run("main", config.claudeConfigDir, now());
  if (!existsSync(config.accountsDir)) return;
  const known = new Set(listAccounts().map((a) => a.config_dir));
  for (const name of readdirSync(config.accountsDir).sort()) {
    const dir = join(config.accountsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!known.has(dir) && !readLogin(dir)) continue;
      prepareAccountDir(dir, config.claudeConfigDir);
      if (!known.has(dir)) insertAccount.run(name, dir, now());
    } catch {
      // A folder we can't read is skipped; the others still count.
    }
  }
}

// plan_size is the size in use; plan_size_set is the one set in Settings, if any.
type Account = Omit<AccountRow, "enabled" | "plan_size"> & AccountState & { plan_size: number; plan_size_set: number | null };

// The plan size set in Settings, else the one the login's tier implies, else Pro's.
const planSize = (a: AccountRow) => a.plan_size ?? planSizeFromTier(a.plan_tier) ?? 1;

function runningByAccount(): Map<number | null, number> {
  const rows = db
    .prepare("SELECT account_id, COUNT(*) AS n FROM runs WHERE status = 'running' GROUP BY account_id")
    .all() as { account_id: number | null; n: number }[];
  return new Map(rows.map((r) => [r.account_id, r.n]));
}

// Claude makes the main folder itself on first run; an extra account's folder holds its login.
function accountStates(): Account[] {
  const running = runningByAccount();
  return listAccounts().map((a) => ({
    ...a,
    enabled: !!a.enabled,
    is_main: isMain(a),
    folder_exists: isMain(a) || existsSync(a.config_dir),
    plan_size: planSize(a),
    plan_size_set: a.plan_size,
    running: running.get(a.id) ?? 0,
  }));
}

// The account the next run should use, or null when none can take one.
export function pickAccount(): Account | null {
  return chooseAccount(accountStates(), getSettings());
}

// Why nothing can start, when no account can take a run.
export function accountsBlocked(): { until: string | null; reason: string } | null {
  const states = accountStates();
  if (chooseAccount(states, getSettings())) return null;
  const until = nextFreeAt(states);
  return until
    ? { until, reason: "Every Claude account has reached its usage limit." }
    : { until: null, reason: "No Claude account can take runs (turned off, or needs a new login). See Settings." };
}

export function markLimited(id: number, resetsAt: Date): void {
  updateAccount(id, { limited_until: resetsAt.toISOString() });
}

export function markLoginFailed(id: number, message: string): void {
  updateAccount(id, { login_error: message, login_error_at: now() });
}

// ---- Usage ----

function loginChangedSince(dir: string, iso: string): boolean {
  try {
    return statSync(join(dir, ".credentials.json")).mtimeMs > Date.parse(iso);
  } catch {
    return false;
  }
}

// Accounts the usage endpoint is rate-limiting: how many times in a row, and when to try again.
// Kept in memory; a restart starts afresh.
const backoff = new Map<number, { times: number; until: number }>();
const backedOff = (id: number) => (backoff.get(id)?.until ?? 0) > Date.now();
const checkedWithin = (a: AccountRow, ms: number) => !!a.usage_checked_at && Date.now() - Date.parse(a.usage_checked_at) < ms;

async function checkUsage(a: AccountRow): Promise<void> {
  const fields: Partial<AccountRow> = { usage_checked_at: now() };
  const login = readLogin(a.config_dir);
  if (login?.rateLimitTier) fields.plan_tier = login.rateLimitTier;
  // Logging in again clears a login problem.
  if (a.login_error && a.login_error_at && loginChangedSince(a.config_dir, a.login_error_at)) {
    fields.login_error = null;
    fields.login_error_at = null;
  }

  if (!login) {
    if (isMain(a)) {
      fields.usage_error = "No saved login to read usage with.";
    } else if (!a.login_error || fields.login_error === null) {
      fields.login_error = `Not logged in. Run add-account ${a.name} in the container.`;
      fields.login_error_at = now();
    }
  } else if (login.expiresAt && login.expiresAt < Date.now()) {
    // Claude renews the token when it next runs; renewing it here could race with a run doing the same.
    fields.usage_error = "The saved login token has expired. Claude renews it on the next run.";
  } else {
    try {
      const res = await fetch(config.usageUrl, {
        headers: { authorization: `Bearer ${login.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      if (res.status === 429) {
        // Its retry-after header says 0, so back off on our own. The last reading stays in use.
        const times = (backoff.get(a.id)?.times ?? 0) + 1;
        const until = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (times - 1));
        backoff.set(a.id, { times, until });
        fields.usage_error = `Anthropic is limiting usage checks. Next try at ${new Date(until).toISOString().slice(11, 16)} UTC; until then the last reading is used.`;
      } else {
        const usage = res.ok ? parseUsage(await res.json().catch(() => null)) : null;
        if (usage) Object.assign(fields, usage, { usage_error: null });
        else fields.usage_error = res.ok ? "Couldn't read the usage reply." : `Usage check failed (HTTP ${res.status}).`;
        if (res.ok) backoff.delete(a.id);
      }
    } catch (err) {
      fields.usage_error = `Usage check failed: ${(err as Error).message}`;
    }
  }
  updateAccount(a.id, fields);
}

// After a run on the account ends, so the next run is routed on what this one used.
export async function checkAccount(id: number): Promise<void> {
  const a = getAccount(id);
  if (a && !backedOff(a.id) && !checkedWithin(a, MIN_CHECK_GAP_MS)) await checkUsage(a);
}

// `force` (Check usage now) reads every account that isn't being rate-limited.
export async function checkAllAccounts({ force = false } = {}): Promise<void> {
  syncAccounts();
  const busy = !!db.prepare("SELECT 1 FROM runs WHERE status IN ('queued', 'running') LIMIT 1").get();
  const running = new Set(
    (db.prepare("SELECT DISTINCT account_id FROM runs WHERE status = 'running'").all() as { account_id: number | null }[]).map(
      (r) => r.account_id,
    ),
  );
  // The accounts the next runs could go to: the primary, or every account in the pool once the primary
  // is past its switch-over point, since the pool is weighed on all their readings.
  const candidates = new Set<number>();
  if (busy) {
    const next = pickAccount();
    if (next) candidates.add(next.id);
    if (next && next.id !== primaryAccount(accountStates())?.id) for (const a of rankPool(accountStates())) candidates.add(a.id);
  }
  const due = (a: AccountRow) => {
    if (backedOff(a.id)) return false;
    if (force) return true;
    const active = running.has(a.id) || candidates.has(a.id);
    return !checkedWithin(a, active ? ACTIVE_CHECK_EVERY_MS : IDLE_CHECK_EVERY_MS);
  };
  await Promise.all(listAccounts().filter((a) => a.enabled && due(a)).map(checkUsage));
}

export function startAccountChecks(log: FastifyBaseLogger, onChecked: () => void): void {
  let checking = false;
  const tick = async () => {
    if (checking) return;
    checking = true;
    try {
      await checkAllAccounts();
      onChecked();
    } catch (err) {
      log.warn(err, "Checking Claude accounts failed");
    } finally {
      checking = false;
    }
  };
  void tick();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

// ---- For the Settings page ----

export function accountViews() {
  const s = getSettings();
  const states = accountStates();
  const nowMs = Date.now();
  const next = chooseAccount(states, s, nowMs);
  const primary = primaryAccount(states);
  // While the pool is taking runs, each pool account's share of them, in proportion to its score.
  const sharing = !!next && next.id !== primary?.id;
  const pool = sharing ? rankPool(states, nowMs) : [];
  const scores = new Map(pool.map((a) => [a.id, poolScore(a, nowMs)]));
  const total = [...scores.values()].reduce((sum, v) => sum + v, 0);
  return states.map((a) => {
    const fiveHour = currentPct(a.five_hour_pct, a.five_hour_resets_at, nowMs);
    const weekly = currentPct(a.seven_day_pct, a.seven_day_resets_at, nowMs);
    const isPrimary = primary?.id === a.id;
    let state: string;
    if (!a.enabled) state = "Turned off";
    else if (!a.folder_exists) state = "Folder missing";
    else if (a.login_error) state = "Needs login";
    else if (a.limited_until && Date.parse(a.limited_until) > nowMs) state = "Limit reached";
    else if (fiveHour >= 100 || weekly >= 100) state = "Full";
    else if (isPrimary && !primaryUnderSwitchOver(a, s, nowMs)) state = "In reserve";
    else state = "Ready";
    return {
      id: a.id,
      name: a.name,
      config_dir: a.config_dir,
      enabled: a.enabled,
      is_main: isMain(a),
      is_primary: isPrimary,
      folder_exists: a.folder_exists,
      state,
      next: next?.id === a.id,
      share_pct: total > 0 && scores.has(a.id) ? Math.round((scores.get(a.id)! / total) * 100) : null,
      running: a.running ?? 0,
      plan_tier: a.plan_tier,
      plan_size: a.plan_size,
      plan_size_set: a.plan_size_set,
      plan_size_auto: planSizeFromTier(a.plan_tier) ?? 1,
      limited_until: a.limited_until && Date.parse(a.limited_until) > nowMs ? a.limited_until : null,
      login_error: a.login_error,
      five_hour_pct: a.five_hour_pct == null ? null : fiveHour,
      five_hour_resets_at: a.five_hour_resets_at,
      seven_day_pct: a.seven_day_pct == null ? null : weekly,
      weekly_limit: hasWeeklyLimit(a),
      seven_day_resets_at: a.seven_day_resets_at,
      usage_checked_at: a.usage_checked_at,
      usage_error: a.usage_error,
    };
  });
}

function mustGet(id: number): AccountRow {
  const a = getAccount(id);
  if (!a) throw new ValidationError("Account not found.");
  return a;
}

export function setAccountEnabled(id: number, enabled: boolean): void {
  mustGet(id);
  updateAccount(id, { enabled: enabled ? 1 : 0 });
}

// null goes back to the size the login's tier implies.
export function setAccountPlanSize(id: number, size: number | null): void {
  mustGet(id);
  updateAccount(id, { plan_size: size });
}

// For "try again" after fixing a login, and to clear a limit that was read wrongly.
export function resetAccount(id: number): void {
  mustGet(id);
  updateAccount(id, { login_error: null, login_error_at: null, limited_until: null });
}

// Only an account whose folder is gone can be forgotten; otherwise it would just be found again.
export function forgetAccount(id: number): void {
  const a = mustGet(id);
  if (isMain(a)) throw new ValidationError("The main account can't be removed. Turn it off instead.");
  if (existsSync(a.config_dir)) {
    throw new ValidationError(`Delete its folder first (rm -rf ${a.config_dir}), or turn it off instead.`);
  }
  db.transaction(() => {
    db.prepare("UPDATE runs SET account_id = NULL WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  })();
}
