import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseAccount, detectLoginFailure, nextFreeAt, parseUsage, hasWeeklyLimit, planSizeFromTier, poolScore } from "../dist/server/routing.js";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const inHours = (h) => new Date(NOW + h * 3600_000).toISOString();
const LATER = "2026-10-27T13:00:00.000Z";
const EARLIER = "2026-10-27T09:00:00.000Z";
const T = { switch_at_5h_pct: 85, switch_at_weekly_pct: 95 };

const account = (id, fields = {}) => ({
  id,
  name: `a${id}`,
  position: id,
  is_main: id === 1,
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

test("main is the primary and takes every run while it's under the switch-over point", () => {
  const low = { five_hour_pct: 40, five_hour_resets_at: LATER };
  assert.equal(pick([account(1, low), account(2), account(3)]), 1);
  // Wherever it is in the list or the order.
  assert.equal(pick([account(2, { position: 1 }), account(3, { position: 2 }), account(1, { position: 3, ...low })]), 1);
});

test("past the switch-over point, runs go to the pool account whose room would reset sooner", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  // 60% left resetting in 30 minutes beats 80% left resetting in 4½ hours, whatever the order.
  const soon = { five_hour_pct: 40, five_hour_resets_at: inHours(0.5) };
  const late = { five_hour_pct: 20, five_hour_resets_at: inHours(4.5) };
  assert.equal(pick([account(1, past), account(2, late), account(3, soon)]), 3);
  assert.equal(pick([account(1, past), account(2, soon), account(3, late)]), 2);
});

test("a sliver left just before a reset doesn't beat a fresh account", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  const sliver = { five_hour_pct: 95, five_hour_resets_at: inHours(0.1) };
  assert.equal(pick([account(1, past), account(2, sliver), account(3)]), 3);
});

test("a bigger plan takes a bigger share", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  const same = { five_hour_pct: 50, five_hour_resets_at: LATER };
  assert.equal(pick([account(1, past), account(2, { ...same, plan_size: 5 }), account(3, { ...same, plan_size: 20 })]), 3);
  // Even with somewhat more used.
  assert.equal(pick([account(1, past), account(2, { ...same, plan_size: 5 }), account(3, { five_hour_pct: 80, five_hour_resets_at: LATER, plan_size: 20 })]), 3);
});

test("runs already going count against an account, so a burst is spread in proportion to room", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  // Account 3 has twice account 2's room per hour.
  const accounts = [account(1, past), account(2, { five_hour_pct: 60, five_hour_resets_at: LATER }), account(3, { five_hour_pct: 20, five_hour_resets_at: LATER })];
  const got = { 2: 0, 3: 0 };
  for (let i = 0; i < 9; i++) {
    const id = pick(accounts);
    got[id]++;
    accounts.find((a) => a.id === id).running = (accounts.find((a) => a.id === id).running ?? 0) + 1;
  }
  assert.deepEqual(got, { 2: 3, 3: 6 });
});

test("an account using its week faster than an even pace is slowed down", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  const fiveHour = { five_hour_pct: 30, five_hour_resets_at: LATER };
  // 90% of the week gone with 5 days still to go, against 50% gone with 3½ days to go.
  const fast = { ...fiveHour, seven_day_pct: 90, seven_day_resets_at: inHours(120) };
  const even = { ...fiveHour, seven_day_pct: 50, seven_day_resets_at: inHours(84) };
  assert.equal(pick([account(1, past), account(2, fast), account(3, even)]), 3);
  assert.ok(poolScore(account(2, fast), NOW) < poolScore(account(3, even), NOW) / 5);
});

test("an account with no weekly limit (Enterprise) gets the most a week can give, and isn't slowed", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  const fiveHour = { five_hour_pct: 30, five_hour_resets_at: LATER };
  const enterprise = account(2, fiveHour);
  const even = account(3, { ...fiveHour, seven_day_pct: 50, seven_day_resets_at: inHours(84) });
  assert.equal(hasWeeklyLimit(enterprise), false);
  assert.equal(hasWeeklyLimit(even), true);
  // No reading at all isn't the same as no weekly limit.
  assert.equal(hasWeeklyLimit(account(4)), true);
  assert.equal(pick([account(1, past), even, enterprise]), 2);
  assert.equal(poolScore(enterprise, NOW), poolScore(even, NOW) * 1.5);
});

test("a primary with no weekly limit shares runs out only on its 5-hour usage", () => {
  assert.equal(pick([account(1, { five_hour_pct: 80, five_hour_resets_at: LATER }), account(2)]), 1);
  assert.equal(pick([account(1, { five_hour_pct: 86, five_hour_resets_at: LATER }), account(2)]), 2);
});

test("the primary's room past the switch-over point is kept in reserve until the pool is full", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  const nearlyFull = { five_hour_pct: 99, five_hour_resets_at: LATER };
  const full = { five_hour_pct: 100, five_hour_resets_at: LATER };
  assert.equal(pick([account(1, past), account(2, nearlyFull), account(3, full)]), 2);
  assert.equal(pick([account(1, past), account(2, full), account(3, { limited_until: LATER })]), 1);
  assert.equal(pick([account(1, full), account(2, full)]), null);
});

test("a limited primary stays primary, so the pool shares the runs rather than filling in order", () => {
  const best = { five_hour_pct: 10, five_hour_resets_at: inHours(1) };
  assert.equal(pick([account(1, { limited_until: LATER }), account(2), account(3, best)]), 3);
});

test("with main off or logged out there's no primary, and every run is shared between the fallbacks", () => {
  const low = { five_hour_pct: 40, five_hour_resets_at: LATER };
  const best = { five_hour_pct: 10, five_hour_resets_at: inHours(1) };
  assert.equal(pick([account(1, { enabled: false }), account(2, low), account(3, best)]), 3);
  assert.equal(pick([account(1, { login_error: "x" }), account(2, low), account(3, best)]), 3);
});

test("the weekly window counts too", () => {
  assert.equal(pick([account(1, { seven_day_pct: 96, seven_day_resets_at: LATER }), account(2)]), 2);
});

test("a reading whose window has reset no longer counts", () => {
  assert.equal(pick([account(1, { five_hour_pct: 100, five_hour_resets_at: EARLIER }), account(2)]), 1);
});

test("skips accounts that are off, limited, logged out or missing", () => {
  const past = { five_hour_pct: 90, five_hour_resets_at: LATER };
  assert.equal(pick([account(1, past), account(2, { enabled: false }), account(3)]), 3);
  assert.equal(pick([account(1, past), account(2, { limited_until: LATER }), account(3)]), 3);
  assert.equal(pick([account(1, past), account(2, { login_error: "Please run /login" }), account(3)]), 3);
  assert.equal(pick([account(1, past), account(2, { folder_exists: false }), account(3)]), 3);
  // A limit that has passed doesn't.
  assert.equal(pick([account(1, { limited_until: EARLIER }), account(2)]), 1);
});

test("unknown usage counts as room", () => {
  assert.equal(pick([account(1)]), 1);
});

test("reads the plan size from the login's rate-limit tier", () => {
  assert.equal(planSizeFromTier("default_claude_max_5x"), 5);
  assert.equal(planSizeFromTier("default_claude_max_20x"), 20);
  assert.equal(planSizeFromTier("default_claude_ai"), 1);
  assert.equal(planSizeFromTier(null), null);
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
