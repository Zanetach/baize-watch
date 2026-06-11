import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export function defaultClaudeStatusLineSnapshotFile({ home = os.homedir() } = {}) {
  return path.join(home, ".baize-watch", "claude-statusline.json");
}

export function extractClaudeStatusLineSnapshot(input, { nowMs = Date.now() } = {}) {
  const data = typeof input === "string" ? parseJsonObject(input) : input;
  const cwd = data?.workspace?.current_dir || data?.cwd || "";

  return {
    version: 1,
    capturedAt: new Date(nowMs).toISOString(),
    cwd: String(cwd || ""),
    sessionId: String(data?.session_id || ""),
    transcriptPath: String(data?.transcript_path || ""),
    model: normalizeModel(data?.model),
    rateLimits: normalizeRateLimits(data?.rate_limits),
    contextWindow: normalizeContextWindow(data?.context_window)
  };
}

export async function readClaudeStatusLineSnapshot(snapshotFile) {
  try {
    const raw = await readFile(snapshotFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeClaudeStatusLineSnapshot(input, {
  snapshotFile = defaultClaudeStatusLineSnapshotFile(),
  nowMs = Date.now()
} = {}) {
  const snapshot = extractClaudeStatusLineSnapshot(input, { nowMs });
  await mkdir(path.dirname(snapshotFile), { recursive: true });
  await writeFile(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return snapshot;
}

export function renderClaudeStatusLine(input) {
  const snapshot = extractClaudeStatusLineSnapshot(input);
  const model = snapshot.model?.displayName || "Claude";
  const windows = [];
  const fiveHour = snapshot.rateLimits?.five_hour;
  const sevenDay = snapshot.rateLimits?.seven_day;

  if (fiveHour?.used_percentage !== null && fiveHour?.used_percentage !== undefined) {
    windows.push(`5h ${Math.round(fiveHour.used_percentage)}%`);
  }
  if (sevenDay?.used_percentage !== null && sevenDay?.used_percentage !== undefined) {
    windows.push(`7d ${Math.round(sevenDay.used_percentage)}%`);
  }

  return windows.length ? `[${model}] ${windows.join(" ")}` : `[${model}]`;
}

function normalizeModel(model) {
  if (!model || typeof model !== "object") return null;
  return {
    id: String(model.id || ""),
    displayName: String(model.display_name || model.displayName || model.id || "")
  };
}

function normalizeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const fiveHour = normalizeRateLimitWindow(rateLimits.five_hour);
  const sevenDay = normalizeRateLimitWindow(rateLimits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return {
    five_hour: fiveHour,
    seven_day: sevenDay
  };
}

function normalizeRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercentage = numberOrNull(window.used_percentage);
  const resetsAt = numberOrNull(window.resets_at);
  if (usedPercentage === null && resetsAt === null) return null;
  return {
    used_percentage: usedPercentage,
    resets_at: resetsAt
  };
}

function normalizeContextWindow(contextWindow) {
  if (!contextWindow || typeof contextWindow !== "object") return null;
  return {
    usedPercentage: numberOrNull(contextWindow.used_percentage),
    remainingPercentage: numberOrNull(contextWindow.remaining_percentage)
  };
}

function parseJsonObject(raw) {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
