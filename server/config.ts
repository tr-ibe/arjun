import { homedir } from "node:os";
import { join } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const appRoot = process.env.APP_ROOT ?? process.cwd();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",

  authUsername: required("AUTH_USERNAME"),
  authPassword: required("AUTH_PASSWORD"),
  sessionSecret: required("SESSION_SECRET"),

  dataDir: process.env.DATA_DIR ?? join(homedir(), "data"),
  runsDir: process.env.RUNS_DIR ?? join(homedir(), "runs"),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  // Extra Claude accounts, one config folder each (the main account uses claudeConfigDir).
  accountsDir: process.env.ACCOUNTS_DIR ?? join(homedir(), "accounts"),
  usageUrl: process.env.CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage",

  // Claude Code plugins every run gets, whichever account it's on: "<git url>#<folder in the repo>",
  // comma-separated. Arjun keeps its own copy of each in pluginsDir. Set PLUGINS to "" for none.
  plugins: (process.env.PLUGINS ?? "https://github.com/tr-ibe/mytribe.git#packages/shared/plugin")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  pluginsDir: process.env.PLUGINS_DIR ?? join(homedir(), "plugins"),
  // Slack's own MCP server, which runs use with Arjun's Slack user token (SLACK_USER_TOKEN).
  slackUserToken: process.env.SLACK_USER_TOKEN || null,
  slackMcpUrl: process.env.SLACK_MCP_URL ?? "https://mcp.slack.com/mcp",
  slackApiUrl: process.env.SLACK_API_URL ?? "https://slack.com/api",

  binDir: join(appRoot, "bin"),
  slackGuard: join(appRoot, "dist", "cli", "slack_guard.js"),
  webDir: join(appRoot, "web", "dist"),

  // Only tests change this, so timeouts can be measured in milliseconds.
  msPerMinute: Number(process.env.MS_PER_MINUTE ?? 60_000),
};
