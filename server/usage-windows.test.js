import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeUsageWindows,
  buildCodexUsageWindow,
  buildRollingUsageWindows,
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

test("rolling usage windows use compact rolling labels for non-reset providers", () => {
  assert.deepEqual(buildRollingUsageWindows({
    primaryUsed: 50_000,
    primaryLimit: 200_000,
    secondaryUsed: 2_500_000,
    secondaryLimit: 50_000_000
  }), [
    {
      kind: "primary",
      label: "5h",
      windowMinutes: 300,
      usedPercent: 25,
      remainingPercent: 25,
      resetAt: null,
      resetText: "roll"
    },
    {
      kind: "secondary",
      label: "7d",
      windowMinutes: 10080,
      usedPercent: 5,
      remainingPercent: 5,
      resetAt: null,
      resetText: "roll"
    }
  ]);
});

test("Claude official subscription windows show reset labels instead of rolling labels", () => {
  assert.deepEqual(buildClaudeUsageWindows({
    five_hour: {
      used_percentage: 39,
      resets_at: 1781181793
    },
    seven_day: {
      used_percentage: 10,
      resets_at: 1781755233
    }
  }, { timeZone: "Asia/Shanghai" }), [
    {
      kind: "primary",
      label: "5h",
      windowMinutes: 300,
      usedPercent: 39,
      remainingPercent: 61,
      resetAt: "2026-06-11T12:43:13.000Z",
      resetText: "20:43"
    },
    {
      kind: "secondary",
      label: "7d",
      windowMinutes: 10080,
      usedPercent: 10,
      remainingPercent: 90,
      resetAt: "2026-06-18T04:00:33.000Z",
      resetText: "6/18"
    }
  ]);
});
