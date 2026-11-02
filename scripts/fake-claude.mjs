#!/usr/bin/env node
// Stands in for the real `claude` CLI in tests: takes the same flags, writes a session file where
// Claude Code would, and calls update_run. Instructions in the prompt control what it does:
//   FAKE_OUTCOME=done|stuck|error|noreport|crash|limit|login   (default done)
//   FAKE_ONLY_IN=<account folder name>   only use FAKE_OUTCOME in that account's folder, else done
//   FAKE_SLEEP=<seconds>                                        (default 0.2)
// When a prompt has several, the last one wins, so a continue's new instructions take effect.
// FAKE_SLEEP also carries over from earlier turns of a resumed session, so a slow run stays slow.
//
// Arjun's login renewal (a run with --no-session-persistence) instead renews the account's saved login,
// the way Claude Code does, unless the account's folder has a file named fake-login-dead. Each one is
// logged to renewals.log in the folder.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = flag("-p") ?? "";
const sessionId = flag("--session-id") ?? flag("--resume");
const directive = (name, fallback, text = prompt) => {
  const all = [...text.matchAll(new RegExp(`${name}=([\\w.,-]+)`, "g"))];
  return all.length ? all[all.length - 1][1] : fallback;
};

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

if (args.includes("--no-session-persistence")) {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  appendFileSync(join(dir, "renewals.log"), `${JSON.stringify(args)}\n`);
  if (process.env.AUTH_PASSWORD || process.env.SLACK_USER_TOKEN) fail("fake-claude: secrets leaked into the environment", 4);
  if (existsSync(join(dir, "fake-login-dead"))) fail("OAuth token has been revoked. Please run /login", 1);
  const file = join(dir, ".credentials.json");
  const creds = JSON.parse(readFileSync(file, "utf8"));
  creds.claudeAiOauth.expiresAt = Date.now() + 8 * 3600_000;
  writeFileSync(file, JSON.stringify(creds));
  console.log("OK");
  process.exit(0);
}

if (!sessionId) fail("fake-claude: no --session-id or --resume", 5);
for (const required of ["--model", "--effort", "--dangerously-skip-permissions"]) {
  if (!args.includes(required)) fail(`fake-claude: missing ${required}`, 5);
}
if (!process.env.RUN_ID) fail("fake-claude: RUN_ID not set", 3);
writeFileSync("claude-args.json", JSON.stringify(args)); // so tests can see how Claude was started
// And which of Arjun's own variables it got (names only; the values are tokens).
writeFileSync("claude-env.json", JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("ARJUN_"))));
if (process.env.AUTH_PASSWORD || process.env.SESSION_SECRET || process.env.SLACK_USER_TOKEN) fail("fake-claude: secrets leaked into the environment", 4);

const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const onlyIn = directive("FAKE_ONLY_IN", null);
const outcome = onlyIn && onlyIn !== basename(configDir) ? "done" : directive("FAKE_OUTCOME", "done");
// Like Claude Code, resuming only works if this account's folder can see the session.
let history = "";
if (args.includes("--resume")) {
  const projects = join(configDir, "projects");
  const dir = existsSync(projects) && readdirSync(projects).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
  if (!dir) fail(`No conversation found with session ID: ${sessionId}`, 1);
  history = readFileSync(join(projects, dir, `${sessionId}.jsonl`), "utf8");
}
const sleepSec = Number(directive("FAKE_SLEEP", directive("FAKE_SLEEP", "0.2", history)));

// Write the session the way Claude Code does.
const projectDir = join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(projectDir, { recursive: true });
const sessionFile = join(projectDir, `${sessionId}.jsonl`);
const write = (row) =>
  appendFileSync(sessionFile, `${JSON.stringify({ ...row, sessionId, timestamp: new Date().toISOString() })}\n`);
const toolId = `toolu_${process.env.RUN_ID}`;
write({ type: "user", message: { role: "user", content: prompt } });
write({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Working on run ${process.env.RUN_ID}.` }] } });
write({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "echo progress >> progress.txt" } }] },
});
appendFileSync("progress.txt", `run ${process.env.RUN_ID}\n`);
write({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "", is_error: false }] },
});

await new Promise((r) => setTimeout(r, sleepSec * 1000));

switch (outcome) {
  case "done":
  case "stuck":
  case "error": {
    const res = spawnSync("update_run", [outcome, `fake ${outcome} for run ${process.env.RUN_ID}`], { encoding: "utf8" });
    if (res.status !== 0) fail(`update_run failed: ${res.stderr || res.error}`, 6);
    console.log(res.stdout.trim());
    console.log("All finished.");
    process.exit(0);
  }
  case "noreport":
    console.log("I did some work but forgot to report.");
    process.exit(0);
  case "crash":
    console.error("boom");
    process.exit(1);
  case "limit":
    console.log("You've hit your limit · resets 3pm (UTC)");
    process.exit(1);
  case "login":
    console.log("Invalid API key · Please run /login");
    process.exit(1);
  default:
    fail(`fake-claude: unknown FAKE_OUTCOME ${outcome}`, 7);
}
