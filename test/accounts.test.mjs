// Runs the real server with three Claude accounts (main, second, third), fake-claude in place of
// `claude`, and a stand-in for Claude's usage endpoint whose numbers each test sets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// What the usage endpoint reports, by account (its token is "tok-<name>"), how often each was asked,
// and which ones it answers "rate limited".
const usage = {};
const hits = {};
const rateLimited = new Set();
const LATER = new Date(Date.now() + 3 * 3600_000).toISOString();
// weekly: false leaves the weekly window out, as for a plan with only the 5-hour limit (Enterprise).
const setUsage = (name, fiveHour, resetsInHours = 3, { weekly = true } = {}) => {
  const resetsAt = new Date(Date.now() + resetsInHours * 3600_000).toISOString();
  usage[name] = { five_hour: { utilization: fiveHour, resets_at: resetsAt } };
  if (weekly) usage[name].seven_day = { utilization: 10, resets_at: LATER };
};

function login(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `tok-${name}`,
        expiresAt: Date.now() + 86400_000,
        scopes: ["user:inference", "user:profile"],
        rateLimitTier: "default_claude_max_5x",
      },
    }),
  );
}

before(async () => {
  chmodSync(fakeClaude, 0o755);
  usageServer = createServer((req, res) => {
    const name = (req.headers.authorization ?? "").replace("Bearer tok-", "");
    hits[name] = (hits[name] ?? 0) + 1;
    if (rateLimited.has(name)) {
      res.writeHead(429, { "retry-after": "0" }).end(JSON.stringify({ error: { type: "rate_limit_error" } }));
      return;
    }
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
  // Older versions shared the main folder's plugins and skills; that link goes.
  mkdirSync(join(mainDir, "plugins"), { recursive: true });
  symlinkSync(join(mainDir, "plugins"), join(accountsDir, "third", "plugins"));
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
      PLUGINS: "",
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
  assert.equal(accounts[0].is_primary, true);
  // The plan comes from the login; no runs are being shared out while the primary has room.
  assert.ok(accounts.every((a) => a.plan_size === 5 && a.plan_size_set === null && a.share_pct === null));
  assert.ok(accounts.every((a) => a.state === "Ready"));
  // Extra accounts share the main account's sessions.
  assert.ok(lstatSync(join(accountsDir, "second", "projects")).isSymbolicLink());
  // Plugins and skills that claude.ai syncs stay with their own login.
  assert.ok(!existsSync(join(accountsDir, "second", "plugins")));
  assert.ok(!existsSync(join(accountsDir, "third", "plugins")));
  assert.equal(JSON.parse(readFileSync(join(accountsDir, "second", "settings.json"), "utf8")).cleanupPeriodDays, 60);
});

test("API keys can't see accounts", async () => {
  const { data } = await call("POST", "/api/keys", { name: "svc" });
  const res = await fetch(`${base}/api/accounts`, { headers: { authorization: `Bearer ${data.key}` } });
  assert.equal(res.status, 403);
});

test("runs on the primary while it's under the switch-over point", async () => {
  const task = await runTask("hello");
  assert.equal(task.latest_run.account_name, "main");
});

test("past the switch-over point, the primary is kept in reserve and runs are shared by room and reset time", async () => {
  setUsage("main", 90);
  // The same room left, but third's resets sooner, so it's used first though it's later in the order.
  setUsage("second", 30, 4);
  setUsage("third", 30, 1);
  let accounts = await check();
  assert.equal(byName(accounts, "main").state, "In reserve");
  assert.equal(byName(accounts, "main").share_pct, null);
  assert.ok(byName(accounts, "third").share_pct > byName(accounts, "second").share_pct);
  assert.equal(byName(accounts, "second").share_pct + byName(accounts, "third").share_pct, 100);
  assert.equal((await runTask("hello")).latest_run.account_name, "third");

  // A bigger plan set in Settings tips it the other way.
  await call("PATCH", `/api/accounts/${byName(accounts, "second").id}`, { plan_size: 20 });
  accounts = (await call("GET", "/api/accounts")).data;
  assert.equal(byName(accounts, "second").plan_size, 20);
  assert.equal((await runTask("hello")).latest_run.account_name, "second");
  await call("PATCH", `/api/accounts/${byName(accounts, "second").id}`, { plan_size: null });
  assert.equal(byName((await call("GET", "/api/accounts")).data, "second").plan_size, 5);
  assert.equal((await call("PATCH", `/api/accounts/${byName(accounts, "second").id}`, { plan_size: -1 })).status, 400);
});

test("an account whose usage has no weekly window has no weekly limit", async () => {
  setUsage("second", 30, 4, { weekly: false });
  setUsage("third", 30, 4);
  // Half its week used, with half the week to go.
  usage.third.seven_day = { utilization: 50, resets_at: new Date(Date.now() + 84 * 3600_000).toISOString() };
  let accounts = await check();
  assert.equal(byName(accounts, "second").weekly_limit, false);
  assert.equal(byName(accounts, "second").seven_day_pct, null);
  assert.equal(byName(accounts, "third").weekly_limit, true);
  // With the same 5-hour room, it gets the bigger share: none of its room is saved for later in the week.
  assert.ok(byName(accounts, "second").share_pct > byName(accounts, "third").share_pct);
  assert.equal((await runTask("hello")).latest_run.account_name, "second");
  setUsage("second", 30, 4);
  accounts = await check();
  assert.equal(byName(accounts, "second").weekly_limit, true);
});

test("moving an account to the top makes it the primary", async () => {
  const accounts = await check();
  const third = byName(accounts, "third").id;
  await call("POST", `/api/accounts/${third}/move`, { direction: "up" });
  await call("POST", `/api/accounts/${third}/move`, { direction: "up" });
  const moved = (await call("GET", "/api/accounts")).data;
  assert.deepEqual(
    moved.map((a) => a.name),
    ["third", "main", "second"],
  );
  assert.equal(byName(moved, "third").is_primary, true);
  assert.equal((await runTask("hello")).latest_run.account_name, "third");
  await call("POST", `/api/accounts/${third}/move`, { direction: "down" });
  await call("POST", `/api/accounts/${third}/move`, { direction: "down" });
});

test("a run that hits the limit continues the same session on another account", async () => {
  // second now looks best, so the run starts there.
  setUsage("second", 30, 1);
  setUsage("third", 30, 4);
  await check();
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
  // main is at 90%, second is limited, so third is next; its login fails, and only main's reserve is left.
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

test("a run ending doesn't read its account again when it was just read", async () => {
  await check();
  const before = hits.main;
  assert.equal((await runTask("hello")).latest_run.account_name, "main");
  assert.equal(hits.main, before);
});

test("when the usage endpoint rate-limits, the account is left alone for a while and its last reading kept", async () => {
  rateLimited.add("second");
  let second = byName(await check(), "second");
  assert.match(second.usage_error, /limiting usage checks. Next try at \d\d:\d\d UTC/);
  assert.equal(typeof second.five_hour_pct, "number");

  const before = hits.second;
  second = byName(await check(), "second"); // even Check usage now waits
  assert.equal(hits.second, before);
  rateLimited.delete("second");
});
