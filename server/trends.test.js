import assert from "node:assert/strict";
import test from "node:test";
import { bucketTokenTrend, normalizeTokenTrend } from "./trends.js";

test("bucketTokenTrend groups token counts into fixed time buckets", () => {
  const hour = 60 * 60 * 1000;
  const nowMs = Date.UTC(2026, 5, 9, 12);
  const points = bucketTokenTrend([
    { timestampMs: nowMs - 3.5 * hour, tokens: 100 },
    { timestampMs: nowMs - 2.5 * hour, tokens: 250 },
    { timestampMs: nowMs - 2.1 * hour, tokens: 50 },
    { timestampMs: nowMs - 30 * 60 * 1000, tokens: 400 },
    { timestampMs: nowMs - 8 * hour, tokens: 999 }
  ], {
    nowMs,
    windowMs: 4 * hour,
    bucketCount: 4
  });

  assert.deepEqual(points, [100, 300, 0, 400]);
});

test("normalizeTokenTrend keeps numeric points and falls back to the current total", () => {
  assert.deepEqual(
    normalizeTokenTrend({ total: 42000, points: [100, "200", null, -3, 300] }, 9000, 4),
    { total: 42000, points: [100, 200, 300] }
  );

  assert.deepEqual(
    normalizeTokenTrend(null, 9000, 4),
    { total: 9000, points: [9000] }
  );
});

test("normalizeTokenTrend uses the current total when a window has only empty buckets", () => {
  assert.deepEqual(
    normalizeTokenTrend({ total: 37648, points: [0, 0, 0, 0] }, null, 4),
    { total: 37648, points: [0, 0, 0, 37648] }
  );
});
