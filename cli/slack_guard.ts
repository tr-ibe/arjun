#!/usr/bin/env node
// PreToolUse hook for runs started from Slack. Work asked for on Slack is read-only, except that
// code may change on a branch and go up as a pull request. Claude Code sends each tool call here
// as JSON on stdin; exiting with 2 blocks the call and shows Claude the reason.
//
// Tools from MCP servers are judged by their name: reading is allowed, anything that sounds like
// a change is blocked unless it's on the short list below. Shell commands are checked against
// known ways to change things. That part is a backstop for the prompt's rules, not a sandbox.

export interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

const READ_WORDS = ["read", "get", "list", "search", "query", "fetch", "find", "view", "describe", "export", "guide"];
const WRITE_WORDS = [
  "create", "update", "delete", "remove", "send", "post", "write", "add", "set", "merge", "push", "trash",
  "label", "unlabel", "mark", "move", "upload", "complete", "schedule", "run", "trigger", "fork", "resolve",
  "apply", "enable", "disable", "forward", "reply", "draft", "submit", "batch", "insert", "patch", "put",
  "cancel", "archive", "execute", "unarchive", "invite", "kick", "rename", "pin", "unpin", "edit",
];
// Changes that are fine from Slack: talking to teammates, and opening pull requests.
const ALLOWED_ACTIONS = ["slack_send_message", "slack_add_reaction", "create_pull_request", "create_branch"];
// Allowed only on a branch other than main or master.
const BRANCH_ACTIONS = ["push_files", "create_or_update_file"];

const PROTECTED_BRANCHES = ["main", "master"];

export function check(call: ToolCall): string | null {
  const name = call.tool_name;
  if (name.startsWith("mcp__")) return checkMcp(name.slice(name.lastIndexOf("__") + 2), call.tool_input);
  if (name === "Bash") return checkShell(String(call.tool_input.command ?? ""));
  return null; // Reading, searching, and editing files in the run's own folder are fine.
}

function checkMcp(action: string, input: Record<string, unknown>): string | null {
  if (ALLOWED_ACTIONS.includes(action)) return null;
  if (BRANCH_ACTIONS.includes(action)) {
    const branch = String(input.branch ?? "");
    return branch && !PROTECTED_BRANCHES.includes(branch) ? null : `${action} is only allowed on a new branch, not main.`;
  }
  const words = action.toLowerCase().split(/[_\-.]/);
  if (words.some((w) => WRITE_WORDS.includes(w)) || !words.some((w) => READ_WORDS.includes(w))) {
    return `${action} changes something, and nothing may be changed from Slack.`;
  }
  return null;
}

// Each rule: what it catches, and why it's blocked.
const SHELL_RULES: [RegExp, string][] = [
  [/\bmytribe\s+(post|patch|put|delete)\b/, "Writing to the mytribe database"],
  [/\b(psql|supabase|pg_restore)\b/, "Connecting to a database directly"],
  [/\b(gcloud|gsutil|bq|kubectl|terraform|docker|pulumi|vercel|netlify|flyctl)\b/, "Changing infrastructure"],
  [/\btrigger(\.dev)?(@\S+)?\s+deploy\b|\b(npm|pnpm|yarn)\s+(publish|deploy)\b/, "Deploying or publishing"],
  [/\bgh\s+pr\s+(merge|close|review)\b/, "Merging, closing or reviewing a pull request"],
  [/\bgh\s+(repo\s+(delete|edit|archive|rename)|release|issue\s+(create|edit|close|delete|comment|lock|transfer)|secret|variable|workflow\s+run|run\s+(rerun|cancel)|label)\b/, "Changing GitHub"],
  [/\bgh\s+api\b.*(\s-X\s*(?![\sG])|--method[\s=](?!GET)|\s-[fF]\s|--field|--raw-field|--input)/, "A GitHub API call that changes something"],
  [/\b(curl|wget|http|xh)\b.*(\s-X\s*(?![\sG])|--request[\s=](?!GET)|\s-d\b|--data|\s-F\b|--form|--upload-file|\s-T\b|--post|--method)/, "An HTTP request that sends data"],
];

function checkShell(command: string): string | null {
  for (const [pattern, what] of SHELL_RULES) {
    if (pattern.test(command)) return `${what} isn't allowed from Slack.`;
  }
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const reason = checkPush(part.trim().split(/\s+/));
    if (reason) return reason;
  }
  return null;
}

// git push is allowed only to a named branch that isn't main or master, and never forced.
function checkPush(words: string[]): string | null {
  const git = words.indexOf("git");
  const push = words.indexOf("push", git);
  if (git < 0 || push < 0) return null;
  const args = words.slice(push + 1);
  if (args.some((a) => /^(-f|--force.*|--delete|-d|--mirror|--all|--tags|--prune)$/.test(a) || a.startsWith("+"))) {
    return "Force-pushing or deleting branches isn't allowed from Slack.";
  }
  const targets = args.filter((a) => !a.startsWith("-"));
  if (targets.length < 2) return "Push with the branch named, e.g. git push -u origin my-branch.";
  for (const ref of targets.slice(1)) {
    const dest = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
    if (PROTECTED_BRANCHES.includes(dest.replace(/^refs\/heads\//, "")) || dest === "HEAD") {
      return "Pushing to main or master isn't allowed from Slack. Push a new branch and open a pull request.";
    }
  }
  return null;
}

// Run as the hook (not when imported by tests).
if (process.argv[1]?.endsWith("slack_guard.js")) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let reason: string | null;
  try {
    reason = check(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ToolCall);
  } catch {
    reason = "The Slack guard couldn't read this tool call, so it was blocked.";
  }
  if (reason) {
    console.error(`Blocked: ${reason}`);
    process.exit(2);
  }
}
