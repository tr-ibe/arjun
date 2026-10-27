// Pausing new runs, and what happens to running work when the server restarts (a deploy).
// Restarts the real server on the same data, with fake-claude in place of `claude`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const Database = createRequire(import.meta.url)(join(root, "node_modules", "better-sqlite3"));
const tmp = mkdtempSync(join(tmpdir(), "arjun-restart-"));
const port = 4100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const fakeClaude = join(root, "scripts", "fake-claude.mjs");
let server;
let cookie;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
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
      ACCOUNTS_DIR: join(tmp, "accounts"),
      CLAUDE_BIN: fakeClaude,
      PLUGINS: "",
      APP_ROOT: root,
      MS_PER_MINUTE: "60000",
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
}

// Like a container being replaced: the server and every Claude process stop at once.
async function restart() {
  const db = new Database(join(tmp, "data", "arjun.db"), { readonly: true });
  const pids = db.prepare("SELECT pid FROM runs WHERE status = 'running' AND pid IS NOT NULL").all();
  db.close();
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGKILL");
  await exited;
  for (const { pid } of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  await startServer();
}

before(async () => {
  chmodSync(fakeClaude, 0o755);
  await startServer();
});

after(() => {
  server?.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const task = async (id) => (await call("GET", `/api/tasks/${id}`)).data;
const status = async () => (await call("GET", "/api/status")).data;

async function waitFor(id, check, what) {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const t = await task(id);
    if (check(t)) return t;
    await sleep(100);
  }
  throw new Error(`task ${id} never ${what}: ${JSON.stringify((await task(id)).runs)}`);
}
const latestIs = (attempt, s) => (t) => t.latest_run.attempt === attempt && t.latest_run.status === s;

test("pausing lets running work finish but starts nothing new, and survives a restart", async () => {
  const { data: running } = await call("POST", "/api/tasks", { prompt: "FAKE_SLEEP=1.5" });
  await waitFor(running.id, latestIs(1, "running"), "started");

  assert.equal((await call("POST", "/api/queue", { paused: true })).status, 200);
  const { data: waiting } = await call("POST", "/api/tasks", { prompt: "waits" });
  let s = await status();
  assert.equal(s.queue_paused, true);
  assert.equal(s.running, 1);

  await waitFor(running.id, latestIs(1, "done"), "finished");
  await sleep(500);
  assert.equal((await task(waiting.id)).latest_run.status, "queued");
  assert.equal((await status()).running, 0);

  await restart();
  assert.equal((await status()).queue_paused, true);
  await sleep(500);
  assert.equal((await task(waiting.id)).latest_run.status, "queued");

  await call("POST", "/api/queue", { paused: false });
  await waitFor(waiting.id, latestIs(1, "done"), "ran after resuming");
});

test("only the web login can pause", async () => {
  const { data } = await call("POST", "/api/keys", { name: "svc" });
  const res = await fetch(`${base}/api/queue`, {
    method: "POST",
    headers: { authorization: `Bearer ${data.key}`, "content-type": "application/json" },
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(res.status, 403);
});

test("a run cut off by a restart continues by itself in the same session", async () => {
  const { data: created } = await call("POST", "/api/tasks", { prompt: "FAKE_SLEEP=2" });
  await waitFor(created.id, latestIs(1, "running"), "started");
  // Once Claude has saved some of the session, there's something to resume.
  for (let i = 0; i < 50 && !(await call("GET", `/api/tasks/${created.id}/timeline`)).data.entries.length; i++) await sleep(100);
  await restart();

  const t = await waitFor(created.id, latestIs(2, "done"), "finished after the restart");
  const [cut, next] = t.runs;
  assert.equal(cut.status, "error");
  assert.match(cut.error, /continues automatically/);
  assert.equal(next.resumed_from_run_id, cut.id);
  assert.match(next.instructions, /server restarted/);
  assert.equal(next.session_id, cut.session_id);
  const args = JSON.parse(readFileSync(join(next.run_dir, "claude-args.json"), "utf8"));
  assert.ok(args.includes("--resume"));
});

test("a continue already queued behind the cut-off run is what picks it up", async () => {
  const { data: created } = await call("POST", "/api/tasks", { prompt: "FAKE_SLEEP=30" });
  await waitFor(created.id, latestIs(1, "running"), "started");
  await call("POST", `/api/tasks/${created.id}/continue`, { message: "Also do the next thing. FAKE_SLEEP=0.2" });
  await restart();

  const t = await waitFor(created.id, latestIs(2, "done"), "finished");
  assert.equal(t.runs.length, 2);
  assert.match(t.runs[0].error, /next queued attempt/);
  assert.match(t.runs[1].instructions, /Also do the next thing/);
});

test("stops picking a run up after three restarts in a row", async () => {
  // Every attempt keeps sleeping (the fake remembers FAKE_SLEEP for the session), so each restart cuts one off.
  const { data: created } = await call("POST", "/api/tasks", { prompt: "FAKE_SLEEP=30" });
  await waitFor(created.id, latestIs(1, "running"), "started");
  for (let attempt = 2; attempt <= 4; attempt++) {
    await restart();
    await waitFor(created.id, latestIs(attempt, "running"), `started attempt ${attempt}`);
  }
  await restart();
  await sleep(500);
  const t = await task(created.id);
  assert.equal(t.runs.length, 4);
  assert.equal(t.latest_run.status, "error");
  assert.match(t.latest_run.error, /Use Continue/);
});
