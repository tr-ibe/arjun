import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

// Arjun's own copy of each plugin in config.plugins, loaded into every run with --plugin-dir. So a
// run has the same plugins whichever Claude account it lands on; what claude.ai syncs to a login
// doesn't matter (a synced plugin with the same name is skipped in favour of this copy).

const execFileP = promisify(execFile);
const UPDATE_EVERY_MS = 10 * 60_000;

export interface PluginView {
  source: string;
  dir: string;
  name: string | null;
  version: string | null;
  commit: string | null;
  committed_at: string | null;
  checked_at: string | null;
  error: string | null;
}

interface Plugin extends PluginView {
  url: string;
  folder: string;
  clone: string;
}

const plugins: Plugin[] = config.plugins.map((source) => {
  const [url, folder = ""] = source.split("#");
  const repo = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("-");
  const clone = join(config.pluginsDir, `${repo}-${folder}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, ""));
  return {
    source,
    url,
    folder,
    clone,
    dir: join(clone, folder),
    name: null,
    version: null,
    commit: null,
    committed_at: null,
    checked_at: null,
    error: null,
  };
});

// Private GitHub repos are read with the gh CLI's login in the container (`gh auth login` once in
// its terminal; it's saved in the home folder volume). git asks gh for credentials as it needs them.
async function git(args: string[], cwd?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!gh auth git-credential",
  };
  const { stdout } = await execFileP("git", args, { cwd, env, timeout: 120_000 });
  return stdout.trim();
}

// Fetches only the plugin's folder: a shallow, sparse checkout of the repo's default branch.
async function update(p: Plugin): Promise<void> {
  p.checked_at = new Date().toISOString();
  try {
    if (!existsSync(join(p.clone, ".git"))) {
      rmSync(p.clone, { recursive: true, force: true });
      mkdirSync(config.pluginsDir, { recursive: true });
      try {
        await git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse", p.url, p.clone]);
        if (p.folder) await git(["sparse-checkout", "set", p.folder], p.clone);
      } catch (err) {
        rmSync(p.clone, { recursive: true, force: true }); // so the next try starts clean
        throw err;
      }
    } else {
      await git(["fetch", "--quiet", "--depth", "1", "origin"], p.clone);
      await git(["reset", "--quiet", "--hard", "@{upstream}"], p.clone);
    }
    if (!existsSync(join(p.dir, ".claude-plugin", "plugin.json"))) {
      throw new Error(`No .claude-plugin/plugin.json in ${p.folder || "the repo"}`);
    }
    p.error = null;
  } catch (err) {
    const message = ((err as { stderr?: string }).stderr || (err as Error).message).trim().split("\n").pop()!;
    const hint = p.url.includes("github.com") ? " If gh isn't logged in, run gh auth login in the container's terminal." : "";
    p.error = `Couldn't update from ${p.url}: ${message}.${hint}`;
  }
  // Describe the copy on disk, updated or not.
  try {
    const manifest = JSON.parse(readFileSync(join(p.dir, ".claude-plugin", "plugin.json"), "utf8"));
    p.name = typeof manifest.name === "string" ? manifest.name : null;
    p.version = typeof manifest.version === "string" ? manifest.version : null;
    [p.commit, p.committed_at] = (await git(["log", "-1", "--format=%h %cI"], p.clone)).split(" ");
  } catch {
    Object.assign(p, { name: null, version: null, commit: null, committed_at: null });
  }
}

let updating: Promise<void> | null = null;

export function updatePlugins(): Promise<void> {
  updating ??= Promise.all(plugins.map(update))
    .then(() => {})
    .finally(() => {
      updating = null;
    });
  return updating;
}

// The folders to pass to Claude. A plugin whose last update failed still runs from the copy it has.
export function pluginDirs(): string[] {
  return plugins.filter((p) => existsSync(join(p.dir, ".claude-plugin", "plugin.json"))).map((p) => p.dir);
}

export function pluginViews(): PluginView[] {
  return plugins.map(({ url: _u, folder: _f, clone: _c, ...view }) => view);
}

// Where a loaded plugin is, by its name.
export function pluginDir(name: string): string | null {
  const p = plugins.find((x) => x.name === name);
  return p && existsSync(join(p.dir, ".claude-plugin", "plugin.json")) ? p.dir : null;
}
