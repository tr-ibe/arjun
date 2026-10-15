#!/usr/bin/env node
// Stands in for the real `claude` CLI in tests: takes the same flags, writes a session file where
// Claude Code would, and calls update_run. Instructions in the prompt control what it does:
//   FAKE_OUTCOME=done|stuck|error|noreport|crash|limit   (default done)
//   FAKE_SLEEP=<seconds>                                  (default 0.2)
// When a prompt has several, the last one wins, so a continue's new instructions take effect.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = flag("-p") ?? "";
const sessionId = flag("--session-id") ?? flag("--resume");
const directive = (name, fallback) => {
  const all = [...prompt.matchAll(new RegExp(`${name}=(\\S+)`, "g"))];
  return all.length ? all[all.length - 1][1] : fallback;
};

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

if (!sessionId) fail("fake-claude: no --session-id or --resume", 5);
for (const required of ["--model", "--effort", "--dangerously-skip-permissions"]) {
  if (!args.includes(required)) fail(`fake-claude: missing ${required}`, 5);
}
if (!process.env.RUN_ID) fail("fake-claude: RUN_ID not set", 3);
if (process.env.AUTH_PASSWORD || process.env.SESSION_SECRET) fail("fake-claude: secrets leaked into the environment", 4);

const outcome = directive("FAKE_OUTCOME", "done");
const sleepSec = Number(directive("FAKE_SLEEP", "0.2"));

// Write the session the way Claude Code does.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
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
  default:
    fail(`fake-claude: unknown FAKE_OUTCOME ${outcome}`, 7);
}
