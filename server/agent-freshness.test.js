import assert from "node:assert/strict";
import test from "node:test";
import { agentFreshness } from "./agent-freshness.js";

test("agent freshness marks current token data fresh", () => {
  assert.deepEqual(agentFreshness("2026-06-09T05:30:00.000Z", {
    nowMs: Date.parse("2026-06-09T05:45:00.000Z"),
    staleAfterMs: 2 * 60 * 60 * 1000
  }), {
    updatedAt: "2026-06-09T05:30:00.000Z",
    ageMs: 15 * 60 * 1000,
    ageMinutes: 15,
    stale: false
  });
});

test("agent freshness marks old Claude Code token data stale", () => {
  assert.deepEqual(agentFreshness("2026-06-08T04:26:15.444Z", {
    nowMs: Date.parse("2026-06-09T05:45:00.000Z"),
    staleAfterMs: 2 * 60 * 60 * 1000
  }), {
    updatedAt: "2026-06-08T04:26:15.444Z",
    ageMs: 91124556,
    ageMinutes: 1519,
    stale: true
  });
});

test("agent freshness handles missing timestamps", () => {
  assert.deepEqual(agentFreshness(null, {
    nowMs: Date.parse("2026-06-09T05:45:00.000Z"),
    staleAfterMs: 2 * 60 * 60 * 1000
  }), {
    updatedAt: null,
    ageMs: null,
    ageMinutes: null,
    stale: true
  });
});
