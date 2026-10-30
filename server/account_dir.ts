import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Used by both the server and the add-account command, so it reads no server config.

// Shared with the main Claude folder rather than kept per account. `projects` holds every session,
// so any account can resume a session another one started; the rest are customisations someone may
// put in the main folder (instructions, agents, commands) that should be the same on every account.
const SHARED = ["projects", "CLAUDE.md", "agents", "commands"];
// Each account keeps its own: claude.ai syncs plugins and skills into these per login, and Arjun gives
// every run its own plugins anyway. Older versions linked them to the main folder, which let one
// account pick up what claude.ai synced to another.
const OWN = ["plugins", "skills"];

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// Sets up an extra account's config folder next to the main one. Safe to run again: it only adds
// what's missing and never touches the login.
export function prepareAccountDir(dir: string, mainDir: string): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(mainDir, "projects"), { recursive: true });
  for (const name of SHARED) {
    const target = join(mainDir, name);
    const link = join(dir, name);
    if (existsSync(target) && !exists(link)) symlinkSync(target, link);
  }
  for (const name of OWN) {
    const link = join(dir, name);
    if (exists(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link) === join(mainDir, name)) unlinkSync(link);
  }
  // Settings start as a copy of the main account's (enabled plugins and the like).
  const settings = join(dir, "settings.json");
  if (!existsSync(settings) && existsSync(join(mainDir, "settings.json"))) {
    copyFileSync(join(mainDir, "settings.json"), settings);
  }
  ensureCleanupPeriod(dir);
}

// Run history lives in Claude's session files, which Claude Code deletes after 30 days by default.
// Keep them for 60 unless someone already chose a value. Every account needs it: they all clean up
// the shared projects folder.
export function ensureCleanupPeriod(dir: string): void {
  const file = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // Don't overwrite a file we can't read.
    }
  }
  if (settings.cleanupPeriodDays !== undefined) return;
  settings.cleanupPeriodDays = 60;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

// The login Claude Code saves in the folder (on Linux; macOS keeps it in the keychain instead).
export interface StoredLogin {
  accessToken: string;
  expiresAt: number | null;
  scopes: string[] | null;
  // E.g. "default_claude_max_5x". Says how big the plan is.
  rateLimitTier: string | null;
}

export function readLogin(dir: string): StoredLogin | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
    const oauth = data?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string") return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : null,
      rateLimitTier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : null,
    };
  } catch {
    return null;
  }
}
