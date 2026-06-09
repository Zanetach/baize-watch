import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexUsageWindow,
  formatResetTextForWindow
} from "./usage-windows.js";

test("codex primary reset text shows the local reset time instead of a countdown", () => {
  assert.equal(formatResetTextForWindow(1780984831, {
    kind: "primary",
    windowMinutes: 300,
    timeZone: "Asia/Shanghai"
  }), "14:00");
});

test("codex weekly reset text shows the local reset date instead of hours remaining", () => {
  assert.equal(formatResetTextForWindow(1781140785, {
    kind: "secondary",
    windowMinutes: 10080,
    timeZone: "Asia/Shanghai"
  }), "6/11");
});

test("codex usage window preserves raw reset time while using compact reset label", () => {
  assert.deepEqual(buildCodexUsageWindow("secondary", {
    used_percent: 42,
    window_minutes: 10080,
    resets_at: 1781140785
  }, { timeZone: "Asia/Shanghai" }), {
    kind: "secondary",
    label: "1w",
    windowMinutes: 10080,
    usedPercent: 42,
    remainingPercent: 58,
    resetAt: "2026-06-11T01:19:45.000Z",
    resetText: "6/11"
  });
});
