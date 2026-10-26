import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseAccount, detectLoginFailure, nextFreeAt, parseUsage } from "../dist/server/routing.js";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const LATER = "2026-10-27T13:00:00.000Z";
const EARLIER = "2026-10-27T09:00:00.000Z";
const T = { switch_at_5h_pct: 85, switch_at_weekly_pct: 95 };

const account = (id, fields = {}) => ({
  id,
  name: `a${id}`,
  position: id,
  enabled: true,
  folder_exists: true,
  login_error: null,
  limited_until: null,
  five_hour_pct: null,
  five_hour_resets_at: null,
  seven_day_pct: null,
  seven_day_resets_at: null,
  ...fields,
});
const pick = (accounts) => chooseAccount(accounts, T, NOW)?.id ?? null;

test("uses the first account until it reaches the switch-over point, then the next, and so on", () => {
  const low = { five_hour_pct: 40, five_hour_resets_at: LATER };
  const high = { five_hour_pct: 90, five_hour_resets_at: LATER };
  assert.equal(pick([account(1, low), account(2, low), account(3, low)]), 1);
  assert.equal(pick([account(1, high), account(2, low), account(3, low)]), 2);
  assert.equal(pick([account(1, high), account(2, high), account(3, low)]), 3);
  assert.equal(pick([account(1, high), account(2, high), account(3, high), account(4, low)]), 4);
});

test("follows position, not list order", () => {
  const high = { five_hour_pct: 90, five_hour_resets_at: LATER };
  assert.equal(pick([account(1, { position: 3 }), account(2, { position: 1, ...high }), account(3, { position: 2 })]), 3);
});

test("the weekly window counts too", () => {
  assert.equal(pick([account(1, { seven_day_pct: 96, seven_day_resets_at: LATER }), account(2)]), 2);
});

test("a reading whose window has reset no longer counts", () => {
  assert.equal(pick([account(1, { five_hour_pct: 100, five_hour_resets_at: EARLIER }), account(2)]), 1);
});

test("skips accounts that are off, limited, logged out or missing", () => {
  assert.equal(pick([account(1, { enabled: false }), account(2)]), 2);
  assert.equal(pick([account(1, { limited_until: LATER }), account(2)]), 2);
  assert.equal(pick([account(1, { login_error: "Please run /login" }), account(2)]), 2);
  assert.equal(pick([account(1, { folder_exists: false }), account(2)]), 2);
  // A limit that has passed doesn't.
  assert.equal(pick([account(1, { limited_until: EARLIER }), account(2)]), 1);
});

test("when all are past the switch-over point, uses the first with room left", () => {
  const full = { five_hour_pct: 100, five_hour_resets_at: LATER };
  assert.equal(pick([account(1, full), account(2, { five_hour_pct: 92, five_hour_resets_at: LATER }), account(3, { five_hour_pct: 88, five_hour_resets_at: LATER })]), 2);
  assert.equal(pick([account(1, full), account(2, full)]), null);
});

test("unknown usage counts as room", () => {
  assert.equal(pick([account(1)]), 1);
});

test("says when the earliest account frees up", () => {
  const soon = "2026-10-27T11:00:00.000Z";
  const accounts = [
    account(1, { limited_until: LATER }),
    account(2, { five_hour_pct: 100, five_hour_resets_at: soon }),
    account(3, { login_error: "x" }),
  ];
  assert.equal(nextFreeAt(accounts, NOW), soon);
  // Out on both windows: free once the later one resets.
  assert.equal(
    nextFreeAt([account(1, { five_hour_pct: 100, five_hour_resets_at: soon, seven_day_pct: 100, seven_day_resets_at: LATER })], NOW),
    LATER,
  );
  assert.equal(nextFreeAt([account(1, { enabled: false }), account(2, { login_error: "x" })], NOW), null);
});

test("reads the usage reply", () => {
  assert.deepEqual(
    parseUsage({
      five_hour: { utilization: 42.5, resets_at: "2026-10-27T13:00:00+00:00" },
      seven_day: { utilization: 12, resets_at: "2026-11-01T00:00:00Z" },
      seven_day_opus: { utilization: 80, resets_at: null },
    }),
    {
      five_hour_pct: 42.5,
      five_hour_resets_at: "2026-10-27T13:00:00.000Z",
      seven_day_pct: 12,
      seven_day_resets_at: "2026-11-01T00:00:00.000Z",
    },
  );
  assert.deepEqual(parseUsage({ five_hour: null, seven_day: { utilization: 3, resets_at: null } }), {
    five_hour_pct: null,
    five_hour_resets_at: null,
    seven_day_pct: 3,
    seven_day_resets_at: null,
  });
  assert.equal(parseUsage({}), null);
  assert.equal(parseUsage("nope"), null);
});

test("reads a list of limits too", () => {
  const usage = parseUsage({
    limits: [
      { kind: "weekly_model", model: "opus", percent: 90, resets_at: 1793000000 },
      { kind: "five_hour", percent: 61, resets_at: 1793000000 },
      { kind: "weekly", percent: 20, resets_at: "2026-11-01T00:00:00Z" },
    ],
  });
  assert.equal(usage.five_hour_pct, 61);
  assert.equal(usage.five_hour_resets_at, new Date(1793000000 * 1000).toISOString());
  assert.equal(usage.seven_day_pct, 20);
});

test("recognises a login that stopped working", () => {
  assert.ok(detectLoginFailure("Invalid API key · Please run /login"));
  assert.ok(detectLoginFailure('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'));
  assert.ok(detectLoginFailure("OAuth token has expired. Please obtain a new token or refresh your existing token."));
  assert.ok(!detectLoginFailure("All done. Opened PR #12."));
});
