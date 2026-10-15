import assert from "node:assert/strict";
import { test } from "node:test";
import { detectUsageLimit } from "../dist/server/limit.js";

const NOW = new Date("2026-10-15T10:00:00Z");

test("ignores output without a usage limit", () => {
  assert.equal(detectUsageLimit("All done. Opened PR #12.", NOW), null);
  assert.equal(detectUsageLimit("API Error: 429 rate limit, retrying", NOW), null);
});

test("reads the epoch form", () => {
  const r = detectUsageLimit("Claude AI usage limit reached|1760540400", NOW);
  assert.equal(r?.resetsAt.toISOString(), new Date(1760540400 * 1000).toISOString());
});

test("reads 'resets 3pm' with a time zone", () => {
  // 3pm in Kolkata (UTC+5:30) is 09:30 UTC, already past at 10:00 UTC, so it's tomorrow. Plus a minute of slack.
  const r = detectUsageLimit("You've hit your limit · resets 3pm (Asia/Kolkata)", NOW);
  assert.equal(r?.resetsAt.toISOString(), "2026-10-16T09:31:00.000Z");
});

test("reads 'resets 3pm' without a time zone as UTC", () => {
  const r = detectUsageLimit("5-hour limit reached ∙ resets 3pm", NOW);
  assert.equal(r?.resetsAt.toISOString(), "2026-10-15T15:01:00.000Z");
});

test("reads a date for the weekly limit", () => {
  const r = detectUsageLimit("Weekly limit reached · resets Oct 20, 9:30am (UTC)", NOW);
  assert.equal(r?.resetsAt.toISOString(), "2026-10-20T09:31:00.000Z");
});

test("falls back to 30 minutes when the reset time is unreadable", () => {
  const r = detectUsageLimit("Usage limit reached. Try again later.", NOW);
  assert.equal(r?.resetsAt.toISOString(), "2026-10-15T10:30:00.000Z");
});
