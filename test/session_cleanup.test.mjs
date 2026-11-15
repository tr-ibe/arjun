// Removing run conversations that have been idle for a week. Folder names start with "-" like Claude
// Code's real ones, which is what broke a hand-run cleanup on the server once.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanUpRunSessions, projectFolderName, savedSessionIds } from "../dist/server/session_cleanup.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-15T12:00:00Z");
const RUNS = "/home/node/runs";

// Writes files (path → age in days) under a fresh projects folder, setting every folder's and file's
// time, since making a folder stamps it with the real now.
function projects(files) {
  const dir = mkdtempSync(join(tmpdir(), "arjun-cleanup-"));
  for (const path of Object.keys(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x".repeat(100));
  }
  const ages = Object.entries(files);
  const stamp = (path, days) => utimesSync(join(dir, path), (NOW - days * DAY) / 1000, (NOW - days * DAY) / 1000);
  // Folders take the age of their oldest file, so a folder's own time never keeps it alive.
  for (const [path] of ages) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      const oldest = Math.max(...ages.filter(([p]) => p.startsWith(`${folder}/`)).map(([, d]) => d));
      stamp(folder, oldest);
    }
  }
  for (const [path, days] of ages) stamp(path, days);
  return dir;
}

const run = (opts) =>
  cleanUpRunSessions({
    runsDir: RUNS,
    maxIdleMs: 7 * DAY,
    inUse: () => new Set(),
    beforeRemove: () => {},
    nowMs: NOW,
    ...opts,
  });

test("names folders the way Claude Code does", () => {
  assert.equal(projectFolderName("/home/node/runs/7680"), "-home-node-runs-7680");
});

test("removes runs idle for over a week and keeps recent ones", async () => {
  const dir = projects({
    "-home-node-runs-1/a.jsonl": 30,
    "-home-node-runs-1/a/subagents/agent-1.jsonl": 30,
    "-home-node-runs-2/b.jsonl": 8,
    "-home-node-runs-3/c.jsonl": 6,
    "-home-node-runs-4/d.jsonl": 0,
  });
  const result = await run({ projectsDir: dir });
  assert.deepEqual(result.removed.sort(), ["-home-node-runs-1", "-home-node-runs-2"]);
  assert.equal(result.bytes, 300);
  assert.deepEqual(readdirSync(dir).sort(), ["-home-node-runs-3", "-home-node-runs-4"]);
});

test("keeps a run while anything in it, even a subagent, changed this week", async () => {
  const dir = projects({
    "-home-node-runs-5/e.jsonl": 20,
    "-home-node-runs-5/e/subagents/agent-1.jsonl": 2,
  });
  assert.deepEqual((await run({ projectsDir: dir })).removed, []);
  assert.ok(existsSync(join(dir, "-home-node-runs-5", "e.jsonl")));
});

test("removes nothing when every run is recent", async () => {
  const files = {};
  for (let i = 1; i <= 50; i++) files[`-home-node-runs-${i}/s.jsonl`] = i % 7;
  const dir = projects(files);
  assert.deepEqual((await run({ projectsDir: dir })).removed, []);
  assert.equal(readdirSync(dir).length, 50);
});

test("spares runs whose task is queued or running", async () => {
  const dir = projects({ "-home-node-runs-6/f.jsonl": 30, "-home-node-runs-7/g.jsonl": 30 });
  const result = await run({ projectsDir: dir, inUse: () => new Set(["/home/node/runs/6"]) });
  assert.deepEqual(result.removed, ["-home-node-runs-7"]);
  assert.ok(existsSync(join(dir, "-home-node-runs-6")));
});

test("leaves folders that aren't run folders alone", async () => {
  const dir = projects({
    "-home-node/h.jsonl": 90,
    "-tmp/i.jsonl": 90,
    "-home-node-runs/j.jsonl": 90,
    "-home-node-runs-8-extra/k.jsonl": 90,
    "-home-node-runsx-9/l.jsonl": 90,
  });
  assert.deepEqual((await run({ projectsDir: dir })).removed, []);
  assert.equal(readdirSync(dir).length, 5);
});

test("refuses a keep period that isn't a number or is under a day", async () => {
  const dir = projects({ "-home-node-runs-10/m.jsonl": 30 });
  await assert.rejects(run({ projectsDir: dir, maxIdleMs: Number.NaN }), /Refusing/);
  await assert.rejects(run({ projectsDir: dir, maxIdleMs: 0 }), /Refusing/);
  assert.ok(existsSync(join(dir, "-home-node-runs-10", "m.jsonl")));
});

test("marks each run before deleting its conversation, and keeps it if marking fails", async () => {
  const dir = projects({ "-home-node-runs-11/n.jsonl": 30, "-home-node-runs-12/o.jsonl": 30 });
  const marked = [];
  const result = await run({
    projectsDir: dir,
    beforeRemove: (runDir) => {
      assert.ok(existsSync(join(dir, projectFolderName(runDir))), "marked before the folder is gone");
      if (runDir.endsWith("/12")) throw new Error("database busy");
      marked.push(runDir);
    },
  });
  assert.deepEqual(marked, ["/home/node/runs/11"]);
  assert.deepEqual(result.removed, ["-home-node-runs-11"]);
  assert.ok(existsSync(join(dir, "-home-node-runs-12", "o.jsonl")));
});

test("lists the sessions that still have a conversation file", () => {
  const dir = projects({
    "-home-node-runs-13/aaa.jsonl": 1,
    "-home-node-runs-13/aaa/subagents/agent-1.jsonl": 1,
    "-home-node-runs-14/bbb.jsonl": 1,
    "-home-node-runs-14/notes.txt": 1,
  });
  assert.deepEqual([...savedSessionIds(dir)].sort(), ["aaa", "bbb"]);
  assert.equal(savedSessionIds(join(dir, "missing")).size, 0);
});

test("does nothing when there is no projects folder", async () => {
  const result = await run({ projectsDir: join(tmpdir(), "arjun-cleanup-missing-folder") });
  assert.deepEqual(result, { removed: [], bytes: 0 });
});
