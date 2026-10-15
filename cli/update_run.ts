#!/usr/bin/env node
// Lets Claude report how its run ended. The server sets RUN_ID and RUNNER_URL when it starts Claude.

const STATUSES = ["done", "stuck", "error"];
const [status, ...rest] = process.argv.slice(2);
const summary = rest.join(" ").trim();

if (!status || !STATUSES.includes(status) || !summary) {
  console.error('Usage: update_run <done|stuck|error> "<summary>"');
  process.exit(2);
}

const runId = process.env.RUN_ID;
const base = process.env.RUNNER_URL;
if (!runId || !base) {
  console.error("update_run only works inside a task run (RUN_ID is not set).");
  process.exit(2);
}

try {
  const res = await fetch(`${base}/internal/runs/${runId}/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, summary }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    console.error(`Report failed: ${body.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  console.log(`Reported: ${status}`);
} catch (err) {
  console.error(`Report failed: could not reach the server (${(err as Error).message}).`);
  process.exit(1);
}
