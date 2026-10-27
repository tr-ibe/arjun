// Runs the real server with scripts/fake-claude.mjs in place of `claude`, and drives it over HTTP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "arjun-test-"));
const port = 4100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const fakeClaude = join(root, "scripts", "fake-claude.mjs");
let server;
let cookie;
let apiKey;

before(async () => {
  chmodSync(fakeClaude, 0o755);
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
      CLAUDE_CONFIG_DIR: join(tmp, "claude"),
      CLAUDE_BIN: fakeClaude,
      PLUGINS: "",
      APP_ROOT: root,
      MS_PER_MINUTE: "1000", // a 1-minute timeout lasts 1 second
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server did not start");
});

after(() => {
  server?.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { body, auth = "cookie", contentType = "application/json" } = {}) {
  const headers = {};
  if (auth === "cookie" && cookie) headers.cookie = cookie;
  if (auth === "key") headers.authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["content-type"] = contentType;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : body,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

async function createTask(body, auth = "cookie") {
  const res = await call("POST", "/api/tasks", { body, auth });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

async function waitFor(taskId, statuses, { attempt, timeoutMs = 15_000 } = {}) {
  const wanted = [].concat(statuses);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await call("GET", `/api/tasks/${taskId}`);
    const run = data.latest_run;
    if (wanted.includes(run.status) && (!attempt || run.attempt === attempt)) return data;
    await sleep(150);
  }
  const { data } = await call("GET", `/api/tasks/${taskId}`);
  throw new Error(`task ${taskId} never reached ${wanted}: ${JSON.stringify(data.latest_run)}`);
}

test("rejects requests without a login or key", async () => {
  assert.equal((await call("GET", "/api/tasks", { auth: "none" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: "admin", password: "nope" }, auth: "none" })).status, 401);
});

test("logs in and sets a session cookie", async () => {
  const res = await call("POST", "/api/auth/login", { body: { username: "admin", password: "correct horse" }, auth: "none" });
  assert.equal(res.status, 200);
  cookie = res.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("GET", "/api/auth/me")).status, 200);
});

test("browser requests that change things must be JSON", async () => {
  const res = await call("POST", "/api/tasks", { body: "prompt=hi", contentType: "application/x-www-form-urlencoded" });
  assert.equal(res.status, 415);
});

test("validates task fields", async () => {
  assert.equal((await call("POST", "/api/tasks", { body: { prompt: "x", priority: 11 } })).status, 400);
  assert.equal((await call("POST", "/api/tasks", { body: { prompt: "" } })).status, 400);
  assert.equal((await call("POST", "/api/tasks", { body: { prompt: "x", effort: "huge" } })).status, 400);
});

test("creates an API key that can create tasks but not manage settings", async () => {
  const res = await call("POST", "/api/keys", { body: { name: "trigger" } });
  assert.equal(res.status, 201);
  apiKey = res.data.key;
  assert.match(apiKey, /^ak_/);
  assert.equal((await call("GET", "/api/settings", { auth: "key" })).status, 403);
  assert.equal((await call("GET", "/api/keys", { auth: "key" })).status, 403);
  assert.equal((await call("GET", "/api/tasks", { auth: "key" })).status, 200);
});

test("runs a task from an API key to done, with timeline and source", async () => {
  const task = await createTask({ title: "Done task", prompt: "Do it. FAKE_OUTCOME=done", type: "provider-profile" }, "key");
  const done = await waitFor(task.id, "done");
  assert.equal(done.source_label, "trigger");
  assert.equal(done.latest_run.summary, `fake done for run ${done.latest_run.id}`);
  assert.equal(done.priority, 5);
  assert.equal(done.model, "sonnet");

  const timeline = (await call("GET", `/api/tasks/${task.id}/timeline`)).data;
  assert.equal(timeline.missing, false);
  assert.ok(timeline.entries.some((e) => e.kind === "tool_use" && e.tool === "Bash"));
  assert.ok(timeline.entries.some((e) => e.kind === "prompt" && e.text.includes("update_run done")));

  const claudeSettings = JSON.parse(readFileSync(join(tmp, "claude", "settings.json"), "utf8"));
  assert.equal(claudeSettings.cleanupPeriodDays, 60);

  const list = (await call("GET", `/api/tasks?type=provider-profile`)).data;
  assert.ok(list.items.some((t) => t.id === task.id));
  assert.deepEqual((await call("GET", "/api/types")).data, ["provider-profile"]);
});

test("lists tasks a page at a time, newest first, with the total", async () => {
  const made = [];
  for (let i = 0; i < 3; i++) made.push(await createTask({ prompt: "page me", type: "paging" }));
  const page = async (offset) => (await call("GET", `/api/tasks?type=paging&limit=2&offset=${offset}`)).data;
  const first = await page(0);
  assert.equal(first.total, 3);
  assert.equal(first.has_more, true);
  assert.deepEqual(first.items.map((t) => t.id), [made[2].id, made[1].id]);
  const second = await page(2);
  assert.equal(second.total, 3);
  assert.equal(second.has_more, false);
  assert.deepEqual(second.items.map((t) => t.id), [made[0].id]);
});

test("continues a stuck task in the same session and folder", async () => {
  const task = await createTask({ prompt: "Try it. FAKE_OUTCOME=stuck" });
  const stuck = await waitFor(task.id, "stuck");
  const first = stuck.latest_run;

  const res = await call("POST", `/api/tasks/${task.id}/continue`, { body: { message: "Here is the key. FAKE_OUTCOME=done" } });
  assert.equal(res.status, 201);
  const done = await waitFor(task.id, "done", { attempt: 2 });
  const second = done.latest_run;

  assert.equal(second.resumed_from_run_id, first.id);
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.run_dir, first.run_dir);
  assert.equal(readFileSync(join(first.run_dir, "progress.txt"), "utf8"), `run ${first.id}\nrun ${second.id}\n`);

  const timeline = (await call("GET", `/api/tasks/${task.id}/timeline`)).data;
  const prompts = timeline.entries.filter((e) => e.kind === "prompt");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].text, /The previous attempt ended as "stuck"/);
});

test("marks a run that never reported as an error, with Claude's last words", async () => {
  const task = await createTask({ prompt: "FAKE_OUTCOME=noreport" });
  const run = (await waitFor(task.id, "error")).latest_run;
  assert.equal(run.error, "Finished without running update_run.");
  assert.match(run.summary, /forgot to report/);
});

test("records a crash", async () => {
  const task = await createTask({ prompt: "FAKE_OUTCOME=crash" });
  const run = (await waitFor(task.id, "error")).latest_run;
  assert.match(run.error, /Exited with code 1\. boom/);
});

test("times out a run that takes too long", async () => {
  const task = await createTask({ prompt: "FAKE_SLEEP=30", timeout_min: 1 });
  const run = (await waitFor(task.id, "timeout", { timeoutMs: 10_000 })).latest_run;
  assert.match(run.error, /1-minute timeout/);
});

test("cancels a running run", async () => {
  const task = await createTask({ prompt: "FAKE_SLEEP=30" });
  const running = await waitFor(task.id, "running");
  const res = await call("POST", `/api/runs/${running.latest_run.id}/cancel`, { body: {} });
  assert.equal(res.status, 200);
  const cancelled = await waitFor(task.id, "cancelled");
  assert.ok(cancelled.latest_run.ended_at);
  assert.equal((await call("POST", `/api/runs/${running.latest_run.id}/cancel`, { body: {} })).status, 409);
});

test("respects max concurrency and starts priority 1 first", async () => {
  assert.equal((await call("PATCH", "/api/settings", { body: { max_concurrency: 1 } })).status, 200);
  const a = await createTask({ prompt: "A FAKE_SLEEP=1", priority: 5 });
  await waitFor(a.id, "running");
  const b = await createTask({ prompt: "B", priority: 9 });
  const c = await createTask({ prompt: "C", priority: 1 });

  const status = (await call("GET", "/api/status")).data;
  assert.equal(status.running, 1);
  assert.equal(status.max_concurrency, 1);
  const cQueued = (await call("GET", `/api/tasks/${c.id}`)).data.latest_run;
  assert.equal(cQueued.queue_position, 1);

  const bDone = await waitFor(b.id, "done");
  const cDone = await waitFor(c.id, "done");
  assert.ok(cDone.latest_run.started_at < bDone.latest_run.started_at, "priority 1 should start first");
  await call("PATCH", "/api/settings", { body: { max_concurrency: 5 } });
});

test("rejects a report for a run that isn't running", async () => {
  const res = await fetch(`${base}/internal/runs/1/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "done", summary: "late" }),
  });
  assert.equal(res.status, 409);
});

test("revoked keys stop working", async () => {
  const keys = (await call("GET", "/api/keys")).data;
  const id = keys.find((k) => k.name === "trigger").id;
  assert.equal((await call("POST", `/api/keys/${id}/revoke`, { body: {} })).status, 200);
  assert.equal((await call("GET", "/api/tasks", { auth: "key" })).status, 401);
});

// Last, because it pauses the queue.
test("pauses on the usage limit and queues a continue", async () => {
  const task = await createTask({ prompt: "FAKE_OUTCOME=limit" });
  await waitFor(task.id, "queued", { attempt: 2 });
  const detail = (await call("GET", `/api/tasks/${task.id}`)).data;
  const [limited, next] = detail.runs;
  assert.equal(limited.status, "limited");
  assert.ok(limited.resets_at);
  assert.equal(next.resumed_from_run_id, limited.id);

  const status = (await call("GET", "/api/status")).data;
  assert.equal(status.paused_until, limited.resets_at);

  // Nothing new starts while paused.
  const other = await createTask({ prompt: "waiting" });
  await sleep(1_000);
  assert.equal((await call("GET", `/api/tasks/${other.id}`)).data.latest_run.status, "queued");
  assert.ok(existsSync(join(tmp, "data", "arjun.db")));
});
