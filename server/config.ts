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

  binDir: join(appRoot, "bin"),
  slackGuard: join(appRoot, "dist", "cli", "slack_guard.js"),
  webDir: join(appRoot, "web", "dist"),

  // Only tests change this, so timeouts can be measured in milliseconds.
  msPerMinute: Number(process.env.MS_PER_MINUTE ?? 60_000),
};
