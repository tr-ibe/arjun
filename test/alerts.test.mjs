// Slack alerts: a small server stands in for Slack and keeps every message Arjun posts, and
// scripts/fake-claude.mjs stands in for Claude Code. A minute lasts 200 ms here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "arjun-alerts-"));
const port = 4100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const fakeClaude = join(root, "scripts", "fake-claude.mjs");
let server;
let slackServer;
let cookie;
// Everything posted with chat.postMessage, in order.
const posted = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  chmodSync(fakeClaude, 0o755);
  slackServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.headers.authorization !== "Bearer xoxp-arjun") return json({ ok: false, error: "invalid_auth" });
      if (req.url === "/api/auth.test") return json({ ok: true, user: "arjun303", team: "mytribe" });
      if (req.url === "/mcp") return json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Slack MCP" } } });
      if (req.url === "/api/chat.postMessage") {
        const body = JSON.parse(raw);
        if (body.channel === "#not-a-member") return json({ ok: false, error: "not_in_channel" });
        posted.push(body);
        return json({ ok: true, ts: `${posted.length}.000` });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => slackServer.listen(0, "127.0.0.1", r));
  const slackBase = `http://127.0.0.1:${slackServer.address().port}`;

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
      CLAUDE_USAGE_URL: `${slackBase}/usage`,
      PLUGINS: "",
      APP_ROOT: root,
      MS_PER_MINUTE: "200",
      SLACK_USER_TOKEN: "xoxp-arjun",
      SLACK_API_URL: `${slackBase}/api`,
      SLACK_MCP_URL: `${slackBase}/mcp`,
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
  server?.kill("SIGKILL");
  slackServer?.close();
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

async function waitFor(check, what, ms = 10_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`never ${what}. Posted: ${JSON.stringify(posted.map((p) => p.text), null, 2)}`);
}

const taskEnds = (id, status) => waitFor(async () => (await task(id)).latest_run.status === status, `ended ${status}`);
const postedSince = (n) => posted.slice(n).map((p) => p.text);

test("settings check the alert fields, and the test alert says what's wrong", async () => {
  const bad = await call("PATCH", "/api/settings", { alert_channel: "two words" });
  assert.equal(bad.status, 400);
  assert.equal((await call("PATCH", "/api/settings", { public_url: "arjun.example.com" })).status, 400);
  assert.equal((await call("PATCH", "/api/settings", { alert_statuses: ["done"] })).status, 400);

  // No channel yet: nothing is sent.
  const none = await call("POST", "/api/alerts/test", {});
  assert.equal(none.status, 400);
  assert.match(none.data.error, /channel/);

  await call("PATCH", "/api/settings", { alert_channel: "#not-a-member" });
  const notIn = await call("POST", "/api/alerts/test", {});
  assert.equal(notIn.status, 400);
  assert.match(notIn.data.error, /Invite him/);

  const { data } = await call("PATCH", "/api/settings", {
    alert_channel: " #arjun-alerts ",
    public_url: "https://arjun.example.com/",
    alert_pause_after_min: 0,
  });
  assert.equal(data.slack_configured, true);
  assert.equal(data.settings.alert_channel, "#arjun-alerts");
  assert.equal(data.settings.public_url, "https://arjun.example.com");
  assert.deepEqual(data.settings.alert_statuses, ["stuck", "error", "timeout"]);

  assert.equal((await call("POST", "/api/alerts/test", {})).status, 200);
  assert.equal(posted.at(-1).channel, "#arjun-alerts");
  assert.match(posted.at(-1).text, /^Test alert from Arjun/);
});

test("a stuck, failed or timed-out task alerts once with a link; a done one doesn't", async () => {
  const before = posted.length;
  const { data: stuck } = await call("POST", "/api/tasks", { title: "Fix <the> build", prompt: "FAKE_OUTCOME=stuck" });
  const { data: done } = await call("POST", "/api/tasks", { prompt: "all good" });
  const { data: crashed } = await call("POST", "/api/tasks", { prompt: "FAKE_OUTCOME=crash" });
  const { data: slow } = await call("POST", "/api/tasks", { prompt: "FAKE_SLEEP=5", timeout_min: 1 });
  await taskEnds(stuck.id, "stuck");
  await taskEnds(done.id, "done");
  await taskEnds(crashed.id, "error");
  await taskEnds(slow.id, "timeout");
  await waitFor(() => posted.length - before >= 3, "posted three alerts");
  await sleep(300);

  const texts = postedSince(before);
  assert.equal(texts.length, 3, texts.join("\n"));
  const stuckText = texts.find((t) => t.includes("is stuck"));
  assert.match(stuckText, new RegExp(`<https://arjun.example.com/tasks/${stuck.id}\\|Fix &lt;the&gt; build>`));
  assert.match(stuckText, /> fake stuck for run/);
  assert.ok(texts.some((t) => t.includes("failed") && t.includes(`task ${crashed.id}`) && t.includes("boom")));
  assert.ok(texts.some((t) => t.includes("timed out") && t.includes(`task ${slow.id}`)));
});

test("only the statuses chosen in Settings alert", async () => {
  await call("PATCH", "/api/settings", { alert_statuses: ["timeout"] });
  const before = posted.length;
  const { data } = await call("POST", "/api/tasks", { prompt: "FAKE_OUTCOME=stuck" });
  await taskEnds(data.id, "stuck");
  await sleep(500);
  assert.deepEqual(postedSince(before), []);
  await call("PATCH", "/api/settings", { alert_statuses: ["stuck", "error", "timeout"] });
});

test("a usage limit on every account alerts once, not per run, and again when an account frees up", async () => {
  const before = posted.length;
  const { data } = await call("POST", "/api/tasks", { prompt: "FAKE_OUTCOME=limit" });
  await waitFor(async () => (await task(data.id)).runs[0].status === "limited", "hit the limit");

  const blocked = await waitFor(() => postedSince(before).find((t) => t.startsWith("No Claude account")), "alerted");
  assert.match(blocked, /usage limit/);
  assert.match(blocked, /<!date\^\d+\^/);
  assert.match(blocked, /1 run is waiting/);
  await sleep(600);
  // The limited run is retried by Arjun himself, so it isn't a task alert, and the account alert isn't repeated.
  assert.equal(postedSince(before).length, 1, postedSince(before).join("\n"));

  const [main] = (await call("GET", "/api/accounts")).data;
  await call("POST", `/api/accounts/${main.id}/reset`, {});
  await waitFor(() => postedSince(before).some((t) => t.includes("can take runs again")), "said it's moving again");
  await taskEnds(data.id, "done");
});

test("a paused queue alerts after the set time, repeats until resumed, then says it's running", async () => {
  await call("PATCH", "/api/settings", { alert_pause_after_min: 2, alert_pause_every_min: 2 });
  await call("POST", "/api/queue", { paused: true });
  const before = posted.length;
  await sleep(250);
  assert.deepEqual(postedSince(before), [], "nothing before 2 minutes");

  await waitFor(() => postedSince(before).length >= 2, "repeated");
  for (const text of postedSince(before)) assert.match(text, /^The queue has been paused for \d+ min/);

  await call("POST", "/api/queue", { paused: false });
  await waitFor(() => postedSince(before).some((t) => t.startsWith("The queue is running again")), "said it's running");
  const count = posted.length;
  await sleep(1_000);
  assert.equal(posted.length, count, "nothing more once resumed");
});
