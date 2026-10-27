// What runs get from Arjun: its own plugins, fetched from git and passed to every run with
// --plugin-dir, the mytribe CLI's sign-in, and Slack's MCP server as Arjun. A local repo stands in
// for GitHub, and a small server for Slack.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "arjun-plugins-"));
const port = 4100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const fakeClaude = join(root, "scripts", "fake-claude.mjs");
const repo = join(tmp, "mytribe");
const pluginsDir = join(tmp, "plugins");
let server;
let slackServer;
let cookie;
// What the stand-in for Slack's MCP server says to initialize: fine, or this app isn't allowed in.
let mcpEnabled = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });

// The plugin's CLI stands in for mytribe's: signed in as Arjun until a signed-out file appears.
const signedOut = join(tmp, "signed-out");
const CLI = `import { existsSync } from "node:fs";
if (existsSync(${JSON.stringify(signedOut)})) {
  console.error("Your mytribe sign-in has ended (Invalid Refresh Token). Use the mytribe setup skill to sign in again.");
  process.exit(1);
}
console.log(JSON.stringify({ env: "production", email: "arjun@mytribe.in", roles: ["team"] }));
`;

function release(version) {
  const plugin = join(repo, "packages", "shared", "plugin");
  const dir = join(plugin, ".claude-plugin");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "mytribe", version }));
  writeFileSync(join(plugin, "scripts", "mytribe.mjs"), CLI);
  git("add", "-A");
  git("commit", "-qm", `release ${version}`);
}

before(async () => {
  chmodSync(fakeClaude, 0o755);
  slackServer = createServer((req, res) => {
    const json = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== "Bearer xoxp-arjun") return json({ ok: false, error: "invalid_auth" });
    if (req.url === "/api/auth.test") return json({ ok: true, user: "arjun303", team: "mytribe" });
    if (req.url === "/mcp") {
      return mcpEnabled
        ? json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Slack MCP" } } })
        : json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "App is not enabled for Slack MCP server access." } });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => slackServer.listen(0, "127.0.0.1", r));
  const slackBase = `http://127.0.0.1:${slackServer.address().port}`;
  mkdirSync(join(repo, "apps"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "apps", "big.txt"), "the rest of the repo");
  release("1.0.0");

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
      APP_ROOT: root,
      MS_PER_MINUTE: "60000",
      LOG_LEVEL: "error",
      PLUGINS: `file://${repo}#packages/shared/plugin, file://${join(tmp, "missing")}#plugin`,
      PLUGINS_DIR: pluginsDir,
      SLACK_USER_TOKEN: "xoxp-arjun", // without SLACK_APP_TOKEN Arjun doesn't listen on Slack, but runs still get Slack
      SLACK_API_URL: `${slackBase}/api`,
      SLACK_MCP_URL: `${slackBase}/mcp`,
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

async function runTask() {
  const { data: task } = await call("POST", "/api/tasks", { prompt: "hello" });
  for (let i = 0; i < 100; i++) {
    const { data } = await call("GET", `/api/tasks/${task.id}`);
    if (!["queued", "running"].includes(data.latest_run.status)) return data.latest_run;
    await sleep(150);
  }
  throw new Error("task never finished");
}

const pluginArgs = (run) => {
  const args = JSON.parse(readFileSync(join(run.run_dir, "claude-args.json"), "utf8"));
  return args.flatMap((a, i) => (a === "--plugin-dir" ? [args[i + 1]] : []));
};

test("fetches only the plugin's folder, and every run gets it", async () => {
  const { plugins } = (await call("GET", "/api/tools")).data;
  const [mytribe, missing] = plugins;
  assert.equal(mytribe.name, "mytribe");
  assert.equal(mytribe.version, "1.0.0");
  assert.equal(mytribe.error, null);
  assert.ok(mytribe.commit && mytribe.committed_at);
  assert.ok(!existsSync(join(mytribe.dir, "..", "..", "..", "apps")), "the rest of the repo isn't checked out");

  // A source that can't be fetched shows why, and doesn't hold runs up.
  assert.match(missing.error, /Couldn't update from/);

  const run = await runTask();
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(pluginArgs(run), [mytribe.dir]);
});

test("picks up a new version", async () => {
  release("1.1.0");
  const { data } = await call("POST", "/api/tools/check", {});
  assert.equal(data.plugins[0].version, "1.1.0");
  const run = await runTask();
  assert.equal(JSON.parse(readFileSync(join(pluginArgs(run)[0], ".claude-plugin", "plugin.json"), "utf8")).version, "1.1.0");
});

test("shows who the mytribe CLI is signed in as, and when the sign-in has ended", async () => {
  let { mytribe } = (await call("GET", "/api/tools")).data;
  assert.equal(mytribe.email, "arjun@mytribe.in");
  assert.deepEqual(mytribe.roles, ["team"]);
  assert.equal(mytribe.error, null);

  writeFileSync(signedOut, "");
  ({ mytribe } = (await call("POST", "/api/tools/check", {})).data);
  assert.equal(mytribe.email, null);
  assert.match(mytribe.error, /sign-in has ended/);
  rmSync(signedOut);
});

test("every run gets Slack's MCP server as Arjun, in place of the account's claude.ai connector", async () => {
  const { slack } = (await call("GET", "/api/tools")).data;
  assert.deepEqual([slack.configured, slack.user, slack.team, slack.error], [true, "arjun303", "mytribe", null]);

  const run = await runTask();
  const args = JSON.parse(readFileSync(join(run.run_dir, "claude-args.json"), "utf8"));
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.match(mcp.mcpServers.slack.url, /\/mcp$/);
  assert.equal(mcp.mcpServers.slack.headers.Authorization, "Bearer ${ARJUN_SLACK_TOKEN}");
  assert.ok(!args.join(" ").includes("xoxp-arjun"));
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]).permissions.deny, ["mcp__claude_ai_Slack"]);
  assert.deepEqual(JSON.parse(readFileSync(join(run.run_dir, "claude-env.json"), "utf8")), ["ARJUN_SLACK_TOKEN"]);
});

test("says when Slack's MCP server won't let the app in", async () => {
  mcpEnabled = false;
  const { slack } = (await call("POST", "/api/tools/check", {})).data;
  assert.match(slack.error, /not enabled for Slack MCP/);
  mcpEnabled = true;
});

test("only the web login sees tools", async () => {
  const { data } = await call("POST", "/api/keys", { name: "svc" });
  const res = await fetch(`${base}/api/tools`, { headers: { authorization: `Bearer ${data.key}` } });
  assert.equal(res.status, 403);
});
