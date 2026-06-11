import assert from "node:assert/strict";
import test from "node:test";
import {
  codexRateLimitPriority,
  isBetterCodexRateLimitEntry
} from "./codex-rate-limits.js";

test("Codex global rate limit has priority over model-specific limit", () => {
  const modelSpecific = {
    timestampMs: Date.parse("2026-06-11T11:42:05.410Z"),
    rateLimits: {
      limit_id: "codex_bengalfox",
      limit_name: "GPT-5.3-Codex-Spark",
      primary: { used_percent: 0 },
      secondary: { used_percent: 0 }
    }
  };
  const globalCodex = {
    timestampMs: Date.parse("2026-06-11T11:35:31.509Z"),
    rateLimits: {
      limit_id: "codex",
      plan_type: "pro",
      primary: { used_percent: 10 },
      secondary: { used_percent: 12 }
    }
  };

  assert.equal(codexRateLimitPriority(modelSpecific.rateLimits), 1);
  assert.equal(codexRateLimitPriority(globalCodex.rateLimits), 3);
  assert.equal(isBetterCodexRateLimitEntry(globalCodex, modelSpecific), true);
  assert.equal(isBetterCodexRateLimitEntry(modelSpecific, globalCodex), false);
});

test("Codex rate limit selection uses newest entry within the same priority", () => {
  const older = {
    timestampMs: 1000,
    rateLimits: { limit_id: "codex", primary: { used_percent: 7 } }
  };
  const newer = {
    timestampMs: 2000,
    rateLimits: { limit_id: "codex", primary: { used_percent: 10 } }
  };

  assert.equal(isBetterCodexRateLimitEntry(newer, older), true);
  assert.equal(isBetterCodexRateLimitEntry(older, newer), false);
});
