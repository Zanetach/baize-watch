import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractClaudeStatusLineSnapshot,
  renderClaudeStatusLine,
  writeClaudeStatusLineSnapshot
} from "./claude-statusline.js";

const statusLineInput = {
  cwd: "/Users/example/project",
  session_id: "session-1",
  transcript_path: "/Users/example/.claude/projects/session.jsonl",
  model: {
    id: "claude-sonnet-4-5",
    display_name: "Sonnet"
  },
  rate_limits: {
    five_hour: {
      used_percentage: 39.4,
      resets_at: 1781181793
    },
    seven_day: {
      used_percentage: 10.2,
      resets_at: 1781755233
    }
  },
  context_window: {
    used_percentage: 8,
    remaining_percentage: 92
  }
};

test("Claude statusLine snapshot preserves official subscription rate limits", () => {
  assert.deepEqual(extractClaudeStatusLineSnapshot(statusLineInput, {
    nowMs: Date.parse("2026-06-11T10:00:00.000Z")
  }), {
    version: 1,
    capturedAt: "2026-06-11T10:00:00.000Z",
    cwd: "/Users/example/project",
    sessionId: "session-1",
    transcriptPath: "/Users/example/.claude/projects/session.jsonl",
    model: {
      id: "claude-sonnet-4-5",
      displayName: "Sonnet"
    },
    rateLimits: {
      five_hour: {
        used_percentage: 39.4,
        resets_at: 1781181793
      },
      seven_day: {
        used_percentage: 10.2,
        resets_at: 1781755233
      }
    },
    contextWindow: {
      usedPercentage: 8,
      remainingPercentage: 92
    }
  });
});

test("Claude statusLine renders compact official rate limit text", () => {
  assert.equal(renderClaudeStatusLine(statusLineInput), "[Sonnet] 5h 39% 7d 10%");
});

test("Claude statusLine writer stores the snapshot as JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baize-watch-statusline-"));
  const snapshotFile = path.join(dir, "claude-statusline.json");

  try {
    await writeClaudeStatusLineSnapshot(JSON.stringify(statusLineInput), {
      snapshotFile,
      nowMs: Date.parse("2026-06-11T10:00:00.000Z")
    });
    const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
    assert.equal(snapshot.rateLimits.five_hour.used_percentage, 39.4);
    assert.equal(snapshot.rateLimits.seven_day.resets_at, 1781755233);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
