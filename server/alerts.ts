import { accountsBlocked } from "./accounts.js";
import { config } from "./config.js";
import { db, getRun, getTask, type RunRow } from "./db.js";
import { getSettings, getState, queuePausedSince, setState, type Settings } from "./settings.js";

// Slack alerts, posted as Arjun with SLACK_USER_TOKEN to the channel set on the Settings page:
// a run that ends needing a person, a queue left paused, and no Claude account able to take runs.

// No account counts as blocked until it has been for this many checks in a row, so a usage
// reading that crosses a threshold for a moment doesn't alert.
const BLOCKED_CHECKS = 2;

let log: { warn: (o: unknown, m?: string) => void } = { warn: (o, m) => console.warn(m ?? "", o) };

const canAlert = (s: Settings) => !!config.slackUserToken && !!s.alert_channel;

const SLACK_ERRORS: Record<string, string> = {
  not_in_channel: "Arjun isn't in that channel. Invite him to it first.",
  channel_not_found: "Slack can't find that channel. Use its ID (in the channel's details) or its exact name.",
  is_archived: "That channel is archived.",
  missing_scope: "SLACK_USER_TOKEN needs the chat:write scope.",
  invalid_auth: "SLACK_USER_TOKEN isn't valid any more.",
  token_revoked: "SLACK_USER_TOKEN has been revoked.",
};

async function post(channel: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${config.slackApiUrl}/chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.slackUserToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (body.ok) return { ok: true };
    return { ok: false, error: SLACK_ERRORS[body.error ?? ""] ?? `Slack said: ${body.error ?? res.status}` };
  } catch (err) {
    return { ok: false, error: `Could not reach Slack: ${(err as Error).message}` };
  }
}

// Alerts never get in the way of the queue: a failure is only logged.
function send(text: string): void {
  const s = getSettings();
  if (!canAlert(s)) return;
  void post(s.alert_channel, text).then((r) => {
    if (!r.ok) log.warn(r.error, "alert not sent");
  });
}

export async function sendTestAlert(): Promise<{ ok: boolean; error?: string }> {
  const s = getSettings();
  if (!config.slackUserToken) return { ok: false, error: "Set SLACK_USER_TOKEN first; alerts are posted as Arjun." };
  if (!s.alert_channel) return { ok: false, error: "Set the alert channel and save first." };
  return post(s.alert_channel, `Test alert from Arjun. Alerts will show up here.${consoleLink(s, "")}`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function quote(text: string, max = 600): string {
  const t = text.trim();
  const cut = t.length > max ? `${t.slice(0, max)}…` : t;
  return cut
    .split("\n")
    .map((l) => `> ${esc(l)}`)
    .join("\n");
}

// Shown in each reader's own time zone.
function slackTime(iso: string): string {
  return `<!date^${Math.floor(Date.parse(iso) / 1000)}^{date_short_pretty} at {time}|${iso}>`;
}

function minutes(ms: number): string {
  const min = Math.round(ms / config.msPerMinute);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

const consoleLink = (s: Settings, path: string) => (s.public_url ? ` <${s.public_url}${path}|Open the console>` : "");

const queuedCount = () => (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").get() as { n: number }).n;
const waiting = (n: number) => (n === 1 ? "1 run is waiting." : `${n} runs are waiting.`);

const STATUS_WORDS: Record<string, string> = { stuck: "is stuck", error: "failed", timeout: "timed out" };

// Called once a run has ended for good, i.e. not when the server is about to retry it itself.
export function alertRunEnded(runId: number): void {
  const s = getSettings();
  if (!canAlert(s)) return;
  const run = getRun(runId);
  if (!run || !s.alert_statuses.includes(run.status)) return;
  const task = getTask(run.task_id);
  if (!task) return;
  const title = s.public_url ? `<${s.public_url}/tasks/${task.id}|${esc(task.title)}>` : `*${esc(task.title)}*`;
  const lines = [`Task ${STATUS_WORDS[run.status]}: ${title} (task ${task.id}, attempt ${run.attempt}, from ${task.source})`];
  const detail = detailFor(run);
  if (detail) lines.push(quote(detail));
  send(lines.join("\n"));
}

function detailFor(run: RunRow): string | null {
  if (run.status === "error" || run.status === "timeout") return run.error ?? run.summary;
  return run.summary ?? run.error;
}

// ---- Checked every minute ----

interface PauseState {
  since: string;
  sent: number;
}

function checkPause(s: Settings): void {
  const since = queuePausedSince();
  const state = getState<PauseState>("alert_pause");
  if (!since) {
    if (state) {
      setState("alert_pause", null);
      if (state.sent > 0) send(`The queue is running again, after being paused for ${minutes(Date.now() - Date.parse(state.since))}.`);
    }
    return;
  }
  if (s.alert_pause_after_min === 0) return;
  const sent = state?.since === since ? state.sent : 0;
  const elapsed = Date.now() - Date.parse(since);
  const over = elapsed / config.msPerMinute - s.alert_pause_after_min;
  if (over < 0) return;
  const due = s.alert_pause_every_min > 0 ? 1 + Math.floor(over / s.alert_pause_every_min) : 1;
  if (due <= sent) return;
  setState("alert_pause", { since, sent: due });
  send(`The queue has been paused for ${minutes(elapsed)}, so no new runs are starting. ${waiting(queuedCount())}${consoleLink(s, "/")}`);
}

let blockedChecks = 0;

function checkAccounts(s: Settings): void {
  const blocked = accountsBlocked();
  blockedChecks = blocked ? blockedChecks + 1 : 0;
  const alerted = getState<boolean>("alert_no_accounts") === true;
  if (!s.alert_no_accounts) {
    if (alerted) setState("alert_no_accounts", false);
    return;
  }
  if (blocked && !alerted && blockedChecks >= BLOCKED_CHECKS) {
    setState("alert_no_accounts", true);
    const until = blocked.until ? ` The first one frees up ${slackTime(blocked.until)}.` : "";
    send(`No Claude account can take runs. ${blocked.reason}${until} ${waiting(queuedCount())}${consoleLink(s, "/settings")}`);
  } else if (!blocked && alerted) {
    setState("alert_no_accounts", false);
    send("A Claude account can take runs again, so the queue is moving.");
  }
}

export function checkAlerts(): void {
  const s = getSettings();
  if (!canAlert(s)) return;
  checkPause(s);
  checkAccounts(s);
}

export function startAlerts(logger: typeof log): void {
  log = logger;
  setInterval(() => {
    try {
      checkAlerts();
    } catch (err) {
      log.warn(err, "alert check failed");
    }
  }, Math.min(60_000, config.msPerMinute)).unref();
}
