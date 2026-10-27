import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { checkAccount, markLimited, markLoginFailed } from "./accounts.js";
import { alertRunEnded } from "./alerts.js";
import { config } from "./config.js";
import { db, getRun, getTask, insertRun, now, updateRun, type RunRow } from "./db.js";
import { detectUsageLimit } from "./limit.js";
import { continuePrompt, firstPrompt, LOGIN_FAILED_MESSAGE, RESTART_MESSAGE, USAGE_LIMIT_MESSAGE } from "./prompt.js";
import { detectLoginFailure } from "./routing.js";
import { findSessionFile } from "./timeline.js";
import { runTools } from "./tools.js";

const TAIL_CHARS = 16_000;
const KILL_GRACE_MS = 5_000;
// Environment variables Claude must never see.
const SECRET_ENV = ["AUTH_USERNAME", "AUTH_PASSWORD", "SESSION_SECRET", "SLACK_USER_TOKEN", "SLACK_APP_TOKEN"];

class Tail {
  private buf = "";
  push(chunk: Buffer) {
    this.buf = (this.buf + chunk.toString("utf8")).slice(-TAIL_CHARS);
  }
  get text() {
    return this.buf;
  }
}

interface Active {
  child: ChildProcess;
  stdout: Tail;
  stderr: Tail;
  timeoutTimer: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  killedFor?: "timeout" | "cancel";
}

const active = new Map<number, Active>();
let onRunEnded: () => void = () => {};

export const activeCount = () => active.size;
export const isActive = (runId: number) => active.has(runId);
export function setOnRunEnded(fn: () => void) {
  onRunEnded = fn;
}

// For a continue: the attempt it follows, and the nearest earlier attempt that actually started
// (that one has the Claude session and the working folder to resume).
function resumeSource(run: RunRow): { previous: RunRow; session: RunRow } | null {
  if (!run.resumed_from_run_id) return null;
  const previous = getRun(run.resumed_from_run_id)!;
  let cur: RunRow | undefined = previous;
  while (cur && !cur.started_at) cur = cur.resumed_from_run_id ? getRun(cur.resumed_from_run_id) : undefined;
  return cur?.session_id && cur.run_dir ? { previous, session: cur } : null;
}

export function startRun(run: RunRow, account: { id: number; config_dir: string }): void {
  const task = getTask(run.task_id)!;
  const source = resumeSource(run);
  // An attempt that failed before Claude saved anything (a limit or a bad login on its first call)
  // has no session to resume, so start a new one in the same folder.
  const canResume = !!source && !!findSessionFile(source.session.session_id!);

  let sessionId: string;
  let runDir: string;
  const args: string[] = [];
  if (source && canResume) {
    sessionId = source.session.session_id!;
    runDir = source.session.run_dir!;
    args.push("-p", continuePrompt(task, source.previous, run.instructions), "--resume", sessionId);
  } else {
    sessionId = randomUUID();
    runDir = source?.session.run_dir ?? join(config.runsDir, String(run.id));
    // A continue whose earlier attempts never started runs as a first attempt with both instructions.
    const instructions = run.resumed_from_run_id ? `${task.prompt}\n\n${run.instructions}` : run.instructions;
    args.push("-p", firstPrompt(task, instructions), "--session-id", sessionId);
  }
  args.push("--model", task.model, "--effort", task.effort, "--dangerously-skip-permissions");
  // Plugins and MCP servers from Arjun, the same on every account.
  const tools = runTools();
  args.push(...tools.args);
  const settings: Record<string, unknown> = {};
  if (tools.deny.length) settings.permissions = { deny: tools.deny };
  // Work asked for on Slack is read-only apart from pull requests, and this hook enforces it.
  if (task.source === "slack") settings.hooks = slackGuardHooks();
  if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));

  mkdirSync(runDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUN_ID: String(run.id),
    RUNNER_URL: `http://127.0.0.1:${config.port}`,
    PATH: `${config.binDir}${delimiter}${process.env.PATH ?? ""}`,
  };
  for (const key of SECRET_ENV) delete env[key];
  Object.assign(env, tools.env);
  // Which login Claude uses. The main account runs exactly as before (without CLAUDE_CONFIG_DIR, Claude
  // also reads ~/.claude.json). Every account shares one projects folder, so sessions resume on any of them.
  if (account.config_dir !== config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = account.config_dir;

  const child = spawn(config.claudeBin, args, {
    cwd: runDir,
    detached: true, // its own process group, so cancel and timeout can stop everything it started
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  updateRun(run.id, {
    status: "running",
    started_at: now(),
    session_id: sessionId,
    run_dir: runDir,
    pid: child.pid ?? null,
    account_id: account.id,
  });

  const entry: Active = {
    child,
    stdout: new Tail(),
    stderr: new Tail(),
    timeoutTimer: setTimeout(() => stopRun(run.id, "timeout"), run.timeout_min * config.msPerMinute),
  };
  active.set(run.id, entry);
  child.stdout!.on("data", (c: Buffer) => entry.stdout.push(c));
  child.stderr!.on("data", (c: Buffer) => entry.stderr.push(c));

  let finished = false;
  const finish = (code: number | null, spawnError?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(entry.timeoutTimer);
    clearTimeout(entry.killTimer);
    // Anything Claude left running in the background goes with it.
    killGroup(child.pid, "SIGKILL");
    active.delete(run.id);
    try {
      finishRun(run.id, code, entry, spawnError);
    } finally {
      onRunEnded();
    }
  };
  child.on("error", (err) => finish(null, err));
  // 'close' waits for stdout to close, which a background process Claude started can hold open.
  // So also finish shortly after the process itself exits.
  child.on("exit", (code) => setTimeout(() => finish(code), 1_000));
  child.on("close", (code) => finish(code));
}

function slackGuardHooks() {
  const hook = { type: "command", command: `node "${config.slackGuard}"` };
  return { PreToolUse: [{ matcher: "*", hooks: [hook] }] };
}

export function stopRun(runId: number, reason: "timeout" | "cancel"): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  entry.killedFor ??= reason;
  killGroup(entry.child.pid, "SIGTERM");
  entry.killTimer ??= setTimeout(() => killGroup(entry.child.pid, "SIGKILL"), KILL_GRACE_MS);
  return true;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function lastLines(text: string, n: number): string {
  return text.trim().split("\n").slice(-n).join("\n").slice(-4_000).trim();
}

function finishRun(runId: number, code: number | null, entry: Active, spawnError?: Error) {
  const run = getRun(runId)!;
  const fields: Partial<RunRow> = { ended_at: now(), exit_code: code };

  let retry: string | null = null;

  // Only fill in a status if Claude didn't report one (and nobody cancelled it).
  if (run.status === "running") {
    const output = `${entry.stdout.text}\n${entry.stderr.text}`;
    // Claude exits with an error when it hits the limit; a clean exit that merely mentions one isn't it.
    const failed = !spawnError && !entry.killedFor && code !== 0;
    const limit = failed ? detectUsageLimit(output) : null;
    const loginFailed = failed && !limit && detectLoginFailure(output);
    if (entry.killedFor === "cancel") {
      fields.status = "cancelled";
    } else if (entry.killedFor === "timeout") {
      fields.status = "timeout";
      fields.error = `Ran longer than its ${run.timeout_min}-minute timeout.`;
    } else if (spawnError) {
      fields.status = "error";
      fields.error = `Could not start Claude: ${spawnError.message}`;
    } else if (limit) {
      fields.status = "limited";
      fields.resets_at = limit.resetsAt.toISOString();
      fields.error = `Usage limit reached${accountLabel(run)}. ${lastLines(output, 3)}`.trim();
      if (run.account_id) markLimited(run.account_id, limit.resetsAt);
      retry = USAGE_LIMIT_MESSAGE;
    } else if (loginFailed) {
      fields.status = "error";
      fields.error = `Claude's login stopped working${accountLabel(run)}. ${lastLines(output, 3)}`.trim();
      if (run.account_id) markLoginFailed(run.account_id, lastLines(output, 3));
      retry = LOGIN_FAILED_MESSAGE;
    } else {
      fields.status = "error";
      fields.summary = lastLines(entry.stdout.text, 20) || null;
      fields.error =
        code === 0
          ? "Finished without running update_run."
          : `Exited with code ${code}. ${lastLines(entry.stderr.text, 10)}`.trim();
    }
  }

  updateRun(runId, fields);

  // Pick the work up again automatically, on the next account that can take it. Only work that
  // isn't picked up again needs a person, so only that is worth an alert.
  if (retry) {
    insertRun({
      task_id: run.task_id,
      instructions: retry,
      timeout_min: run.timeout_min,
      resumed_from_run_id: run.id,
    });
  } else {
    alertRunEnded(runId);
  }
  // A fresh reading, so the next run is routed on what this one used.
  if (run.account_id) void checkAccount(run.account_id).catch(() => {});
}

function accountLabel(run: RunRow): string {
  if (!run.account_id) return "";
  const row = db.prepare("SELECT name FROM accounts WHERE id = ?").get(run.account_id) as { name: string } | undefined;
  return row ? ` on account "${row.name}"` : "";
}

// A run cut off by restarts this many times in a row isn't picked up again automatically.
const MAX_RESTART_RESUMES = 3;

// After a restart no Claude process from before is still ours to watch. Runs that were still going
// continue automatically in the same session, like after a usage limit, unless something is
// already queued to follow them (a Slack reply, say), which resumes the session anyway.
export function recoverInterruptedRuns(): void {
  const cutOff = db
    .prepare("SELECT * FROM runs WHERE status = 'running' AND started_at IS NOT NULL AND ended_at IS NULL")
    .all() as RunRow[];
  const leftForAPerson: number[] = [];
  db.transaction(() => {
    db.prepare(
      `UPDATE runs SET ended_at = ? WHERE started_at IS NOT NULL AND ended_at IS NULL AND status != 'running'`,
    ).run(now());
    for (const run of cutOff) {
      const followed = db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status = 'queued'").get(run.task_id);
      const resume = !followed && restartResumes(run) < MAX_RESTART_RESUMES;
      updateRun(run.id, {
        status: "error",
        ended_at: now(),
        error: followed
          ? "Interrupted by a server restart. The next queued attempt picks it up."
          : resume
            ? "Interrupted by a server restart. It continues automatically."
            : "Interrupted by a server restart again. Use Continue to pick it up.",
      });
      if (resume) {
        insertRun({
          task_id: run.task_id,
          instructions: RESTART_MESSAGE,
          timeout_min: run.timeout_min,
          resumed_from_run_id: run.id,
        });
      } else if (!followed) {
        leftForAPerson.push(run.id);
      }
    }
  })();
  for (const id of leftForAPerson) alertRunEnded(id);
}

// How many attempts in a row, ending with this one, were themselves restart pick-ups.
function restartResumes(run: RunRow): number {
  let n = 0;
  let cur: RunRow | undefined = run;
  while (cur && cur.instructions === RESTART_MESSAGE) {
    n++;
    cur = cur.resumed_from_run_id ? getRun(cur.resumed_from_run_id) : undefined;
  }
  return n;
}
