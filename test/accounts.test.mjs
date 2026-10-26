// Runs the real server with three Claude accounts (main, second, third), fake-claude in place of
// `claude`, and a stand-in for Claude's usage endpoint whose numbers each test sets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "arjun-accounts-"));
const port = 4100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const fakeClaude = join(root, "scripts", "fake-claude.mjs");
const mainDir = join(tmp, "claude");
const accountsDir = join(tmp, "accounts");
let server;
let usageServer;
let cookie;

// What the usage endpoint reports, by account (its token is "tok-<name>").
const usage = {};
const LATER = new Date(Date.now() + 3 * 3600_000).toISOString();
const setUsage = (name, fiveHour) => {
  usage[name] = { five_hour: { utilization: fiveHour, resets_at: LATER }, seven_day: { utilization: 10, resets_at: LATER } };
};

function login(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}`, expiresAt: Date.now() + 86400_000, scopes: ["user:inference", "user:profile"] } }),
  );
}

before(async () => {
  chmodSync(fakeClaude, 0o755);
  usageServer = createServer((req, res) => {
    const name = (req.headers.authorization ?? "").replace("Bearer tok-", "");
    if (req.headers["anthropic-beta"] !== "oauth-2025-04-20" || !usage[name]) {
      res.writeHead(401).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(usage[name]));
  });
  await new Promise((r) => usageServer.listen(0, "127.0.0.1", r));

  login(mainDir, "main");
  login(join(accountsDir, "second"), "second");
  login(join(accountsDir, "third"), "third");
  mkdirSync(join(accountsDir, "not-logged-in"), { recursive: true }); // ignored until it has a login
  for (const name of ["main", "second", "third"]) setUsage(name, 10);

  server = spawn(process.execPath, [join(root, "dist/server/index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AUTH_USERNAME: "admin",
      AUTH_PASSWORD: "correct horse",
      SESSION_SECRET: "test-secret-test-secret-test-secret",
      DATA_DIR: join(tmp, "data"),
      RUNS_DIR: join(tmp, "runs"),
      CLAUDE_CONFIG_DIR: mainDir,
      ACCOUNTS_DIR: accountsDir,
      CLAUDE_USAGE_URL: `http://127.0.0.1:${usageServer.address().port}/api/oauth/usage`,
      CLAUDE_BIN: fakeClaude,
      APP_ROOT: root,
      MS_PER_MINUTE: "1000",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await sleep(100);
  }
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "correct horse" }),
  });
  cookie = res.headers.get("set-cookie").split(";")[0];
});

after(() => {
  server?.kill("SIGTERM");
  usageServer?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const check = async () => (await call("POST", "/api/accounts/check", {})).data;
const byName = (accounts, name) => accounts.find((a) => a.name === name);

async function runTask(prompt, { attempts = 1, status = "done" } = {}) {
  const { data: task } = await call("POST", "/api/tasks", { prompt });
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const { data } = await call("GET", `/api/tasks/${task.id}`);
    if (data.latest_run.attempt === attempts && data.latest_run.status === status) return data;
    await sleep(150);
  }
  const { data } = await call("GET", `/api/tasks/${task.id}`);
  throw new Error(`task ${task.id} never reached ${status} on attempt ${attempts}: ${JSON.stringify(data.runs)}`);
}

test("finds the main account and the logged-in folders, in that order, and reads their usage", async () => {
  const accounts = await check();
  assert.deepEqual(
    accounts.map((a) => a.name),
    ["main", "second", "third"],
  );
  assert.equal(accounts[0].five_hour_pct, 10);
  assert.equal(accounts[0].next, true);
  assert.ok(accounts.every((a) => a.state === "Ready"));
  // Extra accounts share the main account's sessions.
  assert.ok(lstatSync(join(accountsDir, "second", "projects")).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(join(accountsDir, "second", "settings.json"), "utf8")).cleanupPeriodDays, 60);
});

test("API keys can't see accounts", async () => {
  const { data } = await call("POST", "/api/keys", { name: "svc" });
  const res = await fetch(`${base}/api/accounts`, { headers: { authorization: `Bearer ${data.key}` } });
  assert.equal(res.status, 403);
});

test("runs on the first account while it's under the switch-over point", async () => {
  const task = await runTask("hello");
  assert.equal(task.latest_run.account_name, "main");
});

test("moves to the next account once the first passes the switch-over point", async () => {
  setUsage("main", 90);
  await check();
  assert.equal((await runTask("hello")).latest_run.account_name, "second");

  setUsage("second", 86);
  await check();
  assert.equal((await runTask("hello")).latest_run.account_name, "third");
});

test("the order can be changed", async () => {
  setUsage("second", 10);
  const accounts = await check();
  await call("POST", `/api/accounts/${byName(accounts, "third").id}/move`, { direction: "up" });
  const moved = (await call("GET", "/api/accounts")).data;
  assert.deepEqual(
    moved.map((a) => a.name),
    ["main", "third", "second"],
  );
  assert.equal((await runTask("hello")).latest_run.account_name, "third");
  await call("POST", `/api/accounts/${byName(accounts, "third").id}/move`, { direction: "down" });
});

test("a run that hits the limit continues the same session on the next account", async () => {
  const task = await runTask("FAKE_ONLY_IN=second FAKE_OUTCOME=limit", { attempts: 2 });
  const [limited, next] = task.runs;
  assert.equal(limited.status, "limited");
  assert.equal(limited.account_name, "second");
  assert.equal(next.account_name, "third");
  assert.equal(next.session_id, limited.session_id);
  const args = JSON.parse(readFileSync(join(next.run_dir, "claude-args.json"), "utf8"));
  assert.ok(args.includes("--resume"));

  const second = byName((await call("GET", "/api/accounts")).data, "second");
  assert.equal(second.state, "Limit reached");
  assert.ok(second.limited_until);
});

test("a login that stopped working moves on, and falls back to an account past the switch-over point", async () => {
  // main is at 90%, second is limited, so third is next; its login fails, and only main has room left.
  const task = await runTask("FAKE_ONLY_IN=third FAKE_OUTCOME=login", { attempts: 2 });
  const [failed, next] = task.runs;
  assert.equal(failed.status, "error");
  assert.match(failed.error, /login stopped working on account "third"/);
  assert.equal(next.account_name, "main");

  const third = byName((await call("GET", "/api/accounts")).data, "third");
  assert.equal(third.state, "Needs login");
});

test("waits when no account has room, and starts once one does", async () => {
  setUsage("main", 100);
  const accounts = await check();
  const status = (await call("GET", "/api/status")).data;
  // Free again at whichever comes first: main's 5-hour reset or second's limit.
  const frees = [byName(accounts, "main").five_hour_resets_at, byName(accounts, "second").limited_until].sort()[0];
  assert.equal(status.paused_until, new Date(frees).toISOString());
  assert.match(status.paused_reason, /Every Claude account/);

  const { data: task } = await call("POST", "/api/tasks", { prompt: "waiting" });
  await sleep(1_000);
  assert.equal((await call("GET", `/api/tasks/${task.id}`)).data.latest_run.status, "queued");

  // Logging third in again (a new credentials file) clears its problem, and the queue moves.
  await sleep(20);
  login(join(accountsDir, "third"), "third");
  await check();
  const start = Date.now();
  let run;
  while (Date.now() - start < 10_000) {
    run = (await call("GET", `/api/tasks/${task.id}`)).data.latest_run;
    if (run.status === "done") break;
    await sleep(150);
  }
  assert.equal(run.status, "done");
  assert.equal(run.account_name, "third");
});

test("a turned-off account is skipped", async () => {
  setUsage("main", 10);
  const accounts = await check();
  await call("PATCH", `/api/accounts/${byName(accounts, "main").id}`, { enabled: false });
  assert.equal((await runTask("hello")).latest_run.account_name, "third");
  await call("PATCH", `/api/accounts/${byName(accounts, "main").id}`, { enabled: true });
  assert.equal((await runTask("hello")).latest_run.account_name, "main");
  assert.ok(!existsSync(join(accountsDir, "not-logged-in", "projects")));
});
