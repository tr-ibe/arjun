import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { pluginDir, pluginDirs, pluginViews, updatePlugins } from "./plugins.js";

// What every run gets from Arjun itself, whichever Claude account it lands on, and whether it works.

const execFileP = promisify(execFile);
const CHECK_EVERY_MS = 10 * 60_000;

// The mytribe CLI's sign-in lives in the container's home folder (~/.mytribe), not in a Claude
// account, so every run uses the same one. It renews itself; this notices when it has ended.
interface MytribeSignIn {
  email: string | null;
  roles: string[];
  checked_at: string | null;
  error: string | null;
}

const mytribe: MytribeSignIn = { email: null, roles: [], checked_at: null, error: null };

async function checkMytribe(): Promise<void> {
  mytribe.checked_at = new Date().toISOString();
  const dir = pluginDir("mytribe");
  if (!dir) {
    Object.assign(mytribe, { email: null, roles: [], error: "The mytribe plugin isn't loaded, so its CLI can't be checked." });
    return;
  }
  try {
    const { stdout } = await execFileP(process.execPath, [join(dir, "scripts", "mytribe.mjs"), "status"], { timeout: 30_000 });
    const status = JSON.parse(stdout);
    Object.assign(mytribe, {
      email: typeof status.email === "string" ? status.email : null,
      roles: Array.isArray(status.roles) ? status.roles.map(String) : [],
      error: null,
    });
  } catch (err) {
    const message = ((err as { stderr?: string }).stderr || (err as Error).message).trim().slice(0, 500);
    Object.assign(mytribe, { email: null, roles: [], error: message });
  }
}

// Slack, through Slack's own MCP server, as Arjun's Slack user. It replaces the claude.ai Slack
// connector, which belongs to whichever Claude account a run is on and so may post as someone else.
interface SlackSignIn {
  configured: boolean;
  user: string | null;
  team: string | null;
  checked_at: string | null;
  error: string | null;
}

const slack: SlackSignIn = { configured: !!config.slackUserToken, user: null, team: null, checked_at: null, error: null };

// Checks the token (who it is) and that Slack's MCP server lets this app in.
async function checkSlack(): Promise<void> {
  if (!config.slackUserToken) return;
  slack.checked_at = new Date().toISOString();
  const headers = { authorization: `Bearer ${config.slackUserToken}` };
  try {
    const who = (await (await fetch(`${config.slackApiUrl}/auth.test`, { headers, signal: AbortSignal.timeout(10_000) })).json()) as {
      ok: boolean;
      user?: string;
      team?: string;
      error?: string;
    };
    if (!who.ok) throw new Error(`Slack says the token doesn't work: ${who.error}`);
    Object.assign(slack, { user: who.user ?? null, team: who.team ?? null });
    const res = await fetch(config.slackMcpUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "arjun", version: "1" } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // The reply is JSON, or a server-sent event carrying it.
    const body = await res.text();
    const reply = JSON.parse(body.match(/\{.*\}/s)?.[0] ?? "{}") as { result?: unknown; error?: { message?: string } };
    if (!reply.result) throw new Error(reply.error?.message ?? `Slack's MCP server answered HTTP ${res.status}.`);
    slack.error = null;
  } catch (err) {
    slack.error = (err as Error).message;
  }
}

// What a run gets from Arjun when Claude starts. Tokens go in the environment, which the MCP config
// refers to, so they never show up in a command line. `deny` hides the claude.ai connectors that
// Arjun's own servers replace.
export function runTools(): { args: string[]; env: Record<string, string>; deny: string[] } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const deny: string[] = [];
  for (const dir of pluginDirs()) args.push("--plugin-dir", dir);
  const servers: Record<string, unknown> = {};
  if (config.slackUserToken) {
    servers.slack = { type: "http", url: config.slackMcpUrl, headers: { Authorization: "Bearer ${ARJUN_SLACK_TOKEN}" } };
    env.ARJUN_SLACK_TOKEN = config.slackUserToken;
    deny.push("mcp__claude_ai_Slack");
  }
  if (Object.keys(servers).length) args.push("--mcp-config", JSON.stringify({ mcpServers: servers }));
  return { args, env, deny };
}

export function toolViews() {
  return { plugins: pluginViews(), mytribe: { ...mytribe }, slack: { ...slack } };
}

let checking: Promise<void> | null = null;

// Updates the plugins first: the sign-in check uses the mytribe plugin's CLI.
export function checkTools(): Promise<void> {
  checking ??= Promise.all([updatePlugins().then(checkMytribe), checkSlack()])
    .then(() => {})
    .finally(() => {
      checking = null;
    });
  return checking;
}

// Checks now and every few minutes after.
export async function startToolChecks(log: FastifyBaseLogger): Promise<void> {
  const run = async () => {
    await checkTools();
    const { plugins } = toolViews();
    for (const p of plugins) if (p.error) log.warn(p.error);
    if (mytribe.error && pluginDir("mytribe")) log.warn(`mytribe CLI: ${mytribe.error}`);
    if (slack.error) log.warn(`Slack: ${slack.error}`);
  };
  setInterval(() => void run(), CHECK_EVERY_MS).unref();
  await run();
}
