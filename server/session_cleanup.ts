import { existsSync, readdirSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Claude Code keeps each run's conversation in ~/.claude/projects/<working folder with every symbol
// replaced by "-">/, so run 7680 (working folder /home/node/runs/7680) lands in "-home-node-runs-7680".
// Runs that look at many images write tens of MB each, which filled the disk in about two weeks. This
// removes a run's conversation once nothing in it has changed for a while, after marking the run
// (history_removed_at). Its timeline is then empty and its task can no longer be continued.

export function projectFolderName(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

// Every session that still has a conversation file, across all project folders.
export function savedSessionIds(projectsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(projectsDir)) return ids;
  for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(projectsDir, dir.name))) {
      if (file.endsWith(".jsonl")) ids.add(file.slice(0, -".jsonl".length));
    }
  }
  return ids;
}

export interface CleanupOptions {
  projectsDir: string; // ~/.claude/projects
  runsDir: string; // where run working folders live, e.g. /home/node/runs
  maxIdleMs: number;
  // Working folders of runs that may still use their session: anything queued or running. Asked again
  // just before each removal, so a run that starts during a pass is still spared.
  inUse: () => Set<string>;
  // Called with the run's working folder just before its conversation is deleted, so the run can be
  // marked first. If this throws, nothing is deleted.
  beforeRemove: (runDir: string) => void;
  nowMs?: number;
}

export interface CleanupResult {
  removed: string[];
  bytes: number;
}

// Newest change anywhere in the folder, and its size. Doesn't follow symlinks.
async function scan(path: string): Promise<{ newest: number; bytes: number }> {
  const st = await lstat(path);
  let newest = st.mtimeMs;
  let bytes = st.isFile() ? st.size : 0;
  if (st.isDirectory()) {
    for (const name of await readdir(path)) {
      const inner = await scan(join(path, name));
      newest = Math.max(newest, inner.newest);
      bytes += inner.bytes;
    }
  }
  return { newest, bytes };
}

export async function cleanUpRunSessions(opts: CleanupOptions): Promise<CleanupResult> {
  // A bad setting (not a number, or tiny) would make every run look idle. Refuse rather than remove them all.
  if (!Number.isFinite(opts.maxIdleMs) || opts.maxIdleMs < 86_400_000) {
    throw new Error(`Refusing to clean up run conversations: keep-idle period is ${opts.maxIdleMs} ms, under a day`);
  }
  const now = opts.nowMs ?? Date.now();
  const prefix = `${projectFolderName(opts.runsDir)}-`;
  const result: CleanupResult = { removed: [], bytes: 0 };

  let names: string[];
  try {
    names = await readdir(opts.projectsDir);
  } catch {
    return result; // No projects folder yet.
  }

  for (const name of names) {
    // Only run folders: the prefix followed by a run number, nothing else.
    if (!name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) continue;
    const inUse = () => [...opts.inUse()].some((dir) => projectFolderName(dir) === name);
    if (inUse()) continue;
    const path = join(opts.projectsDir, name);
    try {
      const { newest, bytes } = await scan(path);
      if (now - newest < opts.maxIdleMs || inUse()) continue;
      opts.beforeRemove(join(opts.runsDir, name.slice(prefix.length)));
      await rm(path, { recursive: true, force: true });
      result.removed.push(name);
      result.bytes += bytes;
    } catch {
      // Couldn't read or remove it: leave it for the next pass.
    }
  }
  return result;
}

const EVERY_MS = 60 * 60 * 1000;

export function startSessionCleanup(
  log: { info: (msg: string) => void; warn: (err: unknown, msg: string) => void },
  opts: Omit<CleanupOptions, "nowMs">,
): void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { removed, bytes } = await cleanUpRunSessions(opts);
      if (removed.length) {
        const days = Math.round(opts.maxIdleMs / 86_400_000);
        log.info(`Removed ${removed.length} run conversations idle for ${days}+ days (${Math.round(bytes / 1e6)} MB)`);
      }
    } catch (err) {
      log.warn(err, "Cleaning up old run conversations failed");
    } finally {
      busy = false;
    }
  };
  void tick();
  setInterval(tick, EVERY_MS).unref();
}
