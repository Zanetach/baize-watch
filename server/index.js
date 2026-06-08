import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { createVoiceController } from "./voice.js";
import { bucketTokenTrend, normalizeTokenTrend } from "./trends.js";
import { createTranscribeAudio, resolveSttProvider } from "./stt.js";

const execFileAsync = promisify(execFile);
const defaultAgentStatusFile = fileURLToPath(new URL("./agent-status.json", import.meta.url));
const logoFiles = new Map([
  ["codex-color.svg", { path: fileURLToPath(new URL("./public/logos/codex-color.svg", import.meta.url)), type: "image/svg+xml" }],
  ["claudecode-color.svg", { path: fileURLToPath(new URL("./public/logos/claudecode-color.svg", import.meta.url)), type: "image/svg+xml" }],
  ["codex-color.png", { path: fileURLToPath(new URL("./public/logos/codex-color.png", import.meta.url)), type: "image/png" }],
  ["claudecode-color.png", { path: fileURLToPath(new URL("./public/logos/claudecode-color.png", import.meta.url)), type: "image/png" }]
]);

const port = Number.parseInt(process.env.MONITOR_PORT || "8787", 10);
const label = process.env.MONITOR_LABEL || os.hostname();
const gitRepo = process.env.MONITOR_GIT_REPO || process.cwd();
const intervalMs = Number.parseInt(process.env.MONITOR_INTERVAL_MS || "1000", 10);
const agentStatusFile = process.env.MONITOR_AGENT_STATUS_FILE || defaultAgentStatusFile;
const codexStateDb = process.env.MONITOR_CODEX_STATE_DB || `${os.homedir()}/.codex/state_5.sqlite`;
const codexSessionsDir = process.env.MONITOR_CODEX_SESSIONS_DIR || `${os.homedir()}/.codex/sessions`;
const claudeProjectsDir = process.env.MONITOR_CLAUDE_PROJECTS_DIR || `${os.homedir()}/.claude/projects`;
const codexTokenLimit = Number.parseInt(process.env.MONITOR_CODEX_TOKEN_LIMIT || "200000000", 10);
const claudeTokenLimit = Number.parseInt(process.env.MONITOR_CLAUDE_TOKEN_LIMIT || "200000", 10);
const codexWeeklyTokenLimit = Number.parseInt(process.env.MONITOR_CODEX_WEEKLY_TOKEN_LIMIT || "5000000000", 10);
const claudeWeeklyTokenLimit = Number.parseInt(process.env.MONITOR_CLAUDE_WEEKLY_TOKEN_LIMIT || "50000000", 10);
const codexRateLimitCacheMs = 15000;
const sttModel = process.env.MONITOR_STT_MODEL || "gpt-4o-mini-transcribe";
const sttProvider = resolveSttProvider(process.env);
const voiceGain = Number.parseFloat(process.env.MONITOR_VOICE_GAIN || "1.35");
const usageTrendWindowMs = 5 * 60 * 60 * 1000;
const weeklyTrendWindowMs = 7 * 24 * 60 * 60 * 1000;
const trendBucketCount = 12;
const transcribeAudio = createTranscribeAudio({
  provider: sttProvider,
  openaiModel: sttModel,
  execFileAsync
});

let lastCpuSample = sampleCpu();
let codexRateLimitCache = { expiresAt: 0, status: {} };
const voice = createVoiceController({
  transcribeAudio,
  pasteText: pasteIntoFocusedInput,
  pressReturn: pressReturnInFocusedInput,
  config: {
    gain: Number.isFinite(voiceGain) && voiceGain > 0 ? voiceGain : 1
  }
});
let latestStatus = await collectStatus();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/status") {
    latestStatus = await collectStatus();
    sendJson(res, latestStatus);
    return;
  }

  if (url.pathname === "/voice") {
    sendJson(res, { ...voice.status(), provider: sttProvider });
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard());
    return;
  }

  if (url.pathname.startsWith("/logos/")) {
    await sendLogo(url.pathname.slice("/logos/".length), res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/device" && url.pathname !== "/client") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = url.pathname.slice(1);
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", status: latestStatus }));

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      if (ws.role === "device") {
        voice.appendAudio(Buffer.from(raw));
      }
      return;
    }

    const message = raw.toString();
    console.log(`[${new Date().toISOString()}] ${ws.role}: ${message}`);
    await handleTextMessage(ws, message);
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

setInterval(async () => {
  latestStatus = await collectStatus();
  broadcast({ type: "status", status: latestStatus });
}, intervalMs);

server.listen(port, "0.0.0.0", () => {
  const addresses = getLocalAddresses();
  console.log(`StopWatch desktop monitor listening on port ${port}`);
  console.log(`Browser preview: http://localhost:${port}`);
  for (const address of addresses) {
    console.log(`Device WebSocket: ws://${address}:${port}/device`);
  }
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

async function handleTextMessage(ws, message) {
  let payload;
  try {
    payload = JSON.parse(message);
  } catch {
    return;
  }

  if (ws.role !== "device") return;

  if (payload.type === "voice_start") {
    voice.start({ agent: normalizeVoiceAgent(payload.agent) });
    await publishStatus();
    return;
  }

  if (payload.type === "voice_stop") {
    await voice.stop();
    await publishStatus();
    return;
  }

  if (payload.type === "voice_send") {
    await voice.send();
    await publishStatus();
  }
}

async function publishStatus() {
  latestStatus = await collectStatus();
  broadcast({ type: "status", status: latestStatus });
}

async function collectStatus() {
  const [battery, git, memory, agents] = await Promise.all([
    getBattery(),
    getGitStatus(),
    getMemory(),
    getAgents()
  ]);
  const load = os.loadavg();
  const cpuPercent = getCpuPercent();

  return {
    label,
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    time: new Date().toISOString(),
    uptimeSec: Math.round(os.uptime()),
    cpu: {
      percent: Math.round(cpuPercent),
      load1: round(load[0], 2),
      cores: os.cpus().length
    },
    memory,
    battery,
    git,
    agents,
    voice: { ...voice.status(), provider: sttProvider },
    alerts: buildAlerts({ cpuPercent, memoryPercent: memory.percent, battery, git, agents })
  };
}

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }

  return { idle, total };
}

function getCpuPercent() {
  const next = sampleCpu();
  const idleDelta = next.idle - lastCpuSample.idle;
  const totalDelta = next.total - lastCpuSample.total;
  lastCpuSample = next;

  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, 100 - (idleDelta / totalDelta) * 100));
}

async function getBattery() {
  if (process.platform !== "darwin") {
    return { available: false };
  }

  try {
    const { stdout } = await execFileAsync("pmset", ["-g", "batt"], { timeout: 1500 });
    const percentMatch = stdout.match(/(\d+)%/);
    const charging = /AC Power|charging/i.test(stdout) && !/discharging/i.test(stdout);
    const timeMatch = stdout.match(/(\d+:\d+)\s+remaining/i);

    return {
      available: true,
      percent: percentMatch ? Number.parseInt(percentMatch[1], 10) : null,
      charging,
      remaining: timeMatch ? timeMatch[1] : null
    };
  } catch {
    return { available: false };
  }
}

async function getMemory() {
  const totalBytes = os.totalmem();
  const fallbackUsedBytes = totalBytes - os.freemem();
  const fallbackPercent = Math.round((fallbackUsedBytes / totalBytes) * 100);

  if (process.platform !== "darwin") {
    return {
      usedBytes: fallbackUsedBytes,
      totalBytes,
      percent: fallbackPercent,
      source: "os"
    };
  }

  try {
    const { stdout } = await execFileAsync("memory_pressure", [], { timeout: 1500 });
    const match = stdout.match(/System-wide memory free percentage:\s+(\d+)%/i);
    if (!match) throw new Error("memory_pressure_missing_percentage");

    const freePercent = Number.parseInt(match[1], 10);
    const percent = Math.max(0, Math.min(100, 100 - freePercent));
    return {
      usedBytes: Math.round(totalBytes * (percent / 100)),
      totalBytes,
      percent,
      source: "memory_pressure"
    };
  } catch {
    return {
      usedBytes: fallbackUsedBytes,
      totalBytes,
      percent: fallbackPercent,
      source: "os"
    };
  }
}

async function getGitStatus() {
  try {
    const [{ stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
      execFileAsync("git", ["-C", gitRepo, "branch", "--show-current"], { timeout: 1500 }),
      execFileAsync("git", ["-C", gitRepo, "status", "--porcelain"], { timeout: 1500 })
    ]);

    const changed = statusOut.split("\n").filter(Boolean).length;
    return {
      available: true,
      repo: gitRepo,
      branch: branchOut.trim() || "detached",
      changed
    };
  } catch {
    return { available: false };
  }
}

async function getAgents() {
  const [fileStatus, detected, autoStatus] = await Promise.all([
    readAgentStatusFile(),
    detectAgentProcesses(),
    readAutoAgentStatus()
  ]);

  return {
    codex: normalizeAgent("Codex", mergeAgentStatus(autoStatus.codex, fileStatus.codex), detected.codex),
    claude: normalizeAgent("Claude Code", mergeAgentStatus(autoStatus.claude, fileStatus.claude), detected.claude)
  };
}

async function readAgentStatusFile() {
  try {
    const raw = await readFile(agentStatusFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readAutoAgentStatus() {
  const [codex, claude] = await Promise.all([readCodexTokenStatus(), readClaudeTokenStatus()]);
  return { codex, claude };
}

async function readCodexTokenStatus() {
  if (process.platform !== "darwin") return {};

  const [threadStatus, rateLimitStatus] = await Promise.all([
    readCodexThreadTokenStatus(),
    readCodexRateLimitStatus()
  ]);

  return mergeAgentStatus(threadStatus, rateLimitStatus);
}

async function readCodexThreadTokenStatus() {
  if (process.platform !== "darwin") return {};

  try {
    const [latestResult, trendEvents] = await Promise.all([
      execFileAsync("sqlite3", [
        "-json",
        codexStateDb,
        "select tokens_used, title, updated_at, (select coalesce(sum(tokens_used), 0) from threads where updated_at >= strftime('%s','now','-7 days')) as weekly_tokens from threads where archived=0 order by updated_at desc limit 1"
      ], { timeout: 1500 }),
      readCodexTokenEvents()
    ]);
    const { stdout } = latestResult;
    const rows = JSON.parse(stdout || "[]");
    const row = rows[0];
    const used = numberOrNull(row?.tokens_used);
    const weeklyUsed = numberOrNull(row?.weekly_tokens);
    if (used === null) return {};
    const nowMs = Date.now();

    return {
      state: "online",
      task: row?.title || "",
      progress: percentFromTokens(weeklyUsed, codexWeeklyTokenLimit),
      tokens: {
        used,
        limit: codexTokenLimit
      },
      trends: {
        usage: normalizeTokenTrend({
          total: used,
          points: bucketTokenTrend(trendEvents, {
            nowMs,
            windowMs: usageTrendWindowMs,
            bucketCount: trendBucketCount
          })
        }, used, trendBucketCount),
        weekly: normalizeTokenTrend({
          total: weeklyUsed,
          points: bucketTokenTrend(trendEvents, {
            nowMs,
            windowMs: weeklyTrendWindowMs,
            bucketCount: trendBucketCount
          })
        }, weeklyUsed, trendBucketCount)
      },
      updatedAt: timestampFromSeconds(row?.updated_at)
    };
  } catch {
    return {};
  }
}

async function readCodexTokenEvents() {
  try {
    const { stdout } = await execFileAsync("sqlite3", [
      "-json",
      codexStateDb,
      "select tokens_used, updated_at from threads where archived=0 and updated_at >= strftime('%s','now','-7 days') order by updated_at asc limit 400"
    ], { timeout: 1500 });
    const rows = JSON.parse(stdout || "[]");
    return rows.map((row) => ({
      timestampMs: numberOrZero(row?.updated_at) * 1000,
      tokens: numberOrZero(row?.tokens_used)
    }));
  } catch {
    return [];
  }
}

async function readCodexRateLimitStatus() {
  const now = Date.now();
  if (now < codexRateLimitCache.expiresAt) return codexRateLimitCache.status;

  try {
    const files = await listRecentJsonlFiles(codexSessionsDir, 12);
    let newest = null;

    for (const file of files) {
      const entry = await readLatestCodexRateLimits(file.path);
      if (entry && (!newest || entry.timestampMs > newest.timestampMs)) {
        newest = entry;
      }
    }

    const usageWindows = buildCodexUsageWindows(newest?.rateLimits);
    const status = usageWindows.length
      ? {
          usageWindows,
          updatedAt: newest?.timestampMs ? new Date(newest.timestampMs).toISOString() : null
        }
      : {};

    codexRateLimitCache = { expiresAt: now + codexRateLimitCacheMs, status };
    return status;
  } catch {
    codexRateLimitCache = { expiresAt: now + codexRateLimitCacheMs, status: {} };
    return {};
  }
}

async function readLatestCodexRateLimits(file) {
  try {
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");

    for (let index = lines.length - 1; index >= 0; index--) {
      let entry;
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        continue;
      }

      const rateLimits = entry?.payload?.rate_limits || entry?.rate_limits;
      if (!rateLimits) continue;

      const timestampMs = Date.parse(entry.timestamp || entry?.payload?.timestamp || "");
      return {
        rateLimits,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function readClaudeTokenStatus() {
  if (process.platform !== "darwin") return {};

  try {
    const files = await listRecentJsonlFiles(claudeProjectsDir, 30);
    let newest = null;
    let weeklyUsed = 0;
    const trendEvents = [];
    const weeklyCutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const file of files) {
      const summary = await readClaudeUsageSummary(file.path, weeklyCutoffMs);
      weeklyUsed += summary.weeklyUsed;
      trendEvents.push(...summary.events);
      if (summary.latest && (!newest || summary.latest.timestampMs > newest.timestampMs)) {
        newest = summary.latest;
      }
    }

    if (!newest) return {};
    const used = newest.input + newest.output + newest.cacheCreation + newest.cacheRead;
    const nowMs = Date.now();
    return {
      state: "online",
      task: newest.cwd ? shortPath(newest.cwd) : "",
      progress: percentFromTokens(weeklyUsed, claudeWeeklyTokenLimit),
      tokens: {
        used,
        limit: claudeTokenLimit
      },
      trends: {
        usage: normalizeTokenTrend({
          total: used,
          points: bucketTokenTrend(trendEvents, {
            nowMs,
            windowMs: usageTrendWindowMs,
            bucketCount: trendBucketCount
          })
        }, used, trendBucketCount),
        weekly: normalizeTokenTrend({
          total: weeklyUsed,
          points: bucketTokenTrend(trendEvents, {
            nowMs,
            windowMs: weeklyTrendWindowMs,
            bucketCount: trendBucketCount
          })
        }, weeklyUsed, trendBucketCount)
      },
      updatedAt: new Date(newest.timestampMs).toISOString()
    };
  } catch {
    return {};
  }
}

async function detectAgentProcesses() {
  if (process.platform !== "darwin") {
    return { codex: false, claude: false };
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-fl", "codex|claude"], { timeout: 1500 });
    const lines = stdout.split("\n").filter(Boolean);
    return {
      codex: lines.some((line) => /\bcodex\b/i.test(line)),
      claude: lines.some((line) => /\bclaude\b/i.test(line))
    };
  } catch {
    return { codex: false, claude: false };
  }
}

function normalizeAgent(name, raw = {}, processOnline = false) {
  const tokens = raw.tokens || {};
  const tokensUsed = numberOrNull(raw.tokensUsed ?? tokens.used);
  const tokensLimit = numberOrNull(raw.tokensLimit ?? tokens.limit);
  const weeklyTokensUsed = numberOrNull(raw.weeklyTokensUsed ?? tokens.weeklyUsed ?? tokens.weekly);
  const explicitTokenPercent = numberOrNull(raw.tokenPercent ?? tokens.percent);
  const tokenPercent = clampPercent(
    explicitTokenPercent ?? (tokensUsed !== null && tokensLimit ? (tokensUsed / tokensLimit) * 100 : null)
  );
  const progress = clampPercent(numberOrNull(raw.progress ?? raw.progressPercent));
  const online = typeof raw.online === "boolean" ? raw.online : processOnline;
  const usageWindows = normalizeUsageWindows(raw.usageWindows);
  const trends = raw.trends || {};

  return {
    name,
    online,
    state: String(raw.state || (online ? "online" : "offline")),
    task: String(raw.task || raw.currentTask || ""),
    progress,
    tokens: {
      used: tokensUsed,
      limit: tokensLimit,
      percent: tokenPercent
    },
    trends: {
      usage: normalizeTokenTrend(raw.usageTrend ?? trends.usage, tokensUsed, trendBucketCount),
      weekly: normalizeTokenTrend(raw.weeklyTrend ?? trends.weekly, weeklyTokensUsed, trendBucketCount)
    },
    usageWindows,
    updatedAt: raw.updatedAt || raw.lastUpdated || null,
    source: {
      file: Boolean(Object.keys(raw).length),
      process: processOnline
    }
  };
}

function mergeAgentStatus(fallback = {}, override = {}) {
  const merged = { ...(fallback || {}), ...(override || {}) };
  if (fallback?.tokens || override?.tokens) {
    merged.tokens = { ...(fallback?.tokens || {}), ...(override?.tokens || {}) };
  }
  if (fallback?.usageWindows || override?.usageWindows) {
    merged.usageWindows = override?.usageWindows || fallback?.usageWindows;
  }
  if (fallback?.trends || override?.trends) {
    merged.trends = {
      ...(fallback?.trends || {}),
      ...(override?.trends || {})
    };
  }
  return merged;
}

function normalizeUsageWindows(windows) {
  if (!Array.isArray(windows)) return [];

  return windows.map((window) => {
    const usedPercent = clampPercent(numberOrNull(window?.usedPercent));
    const fallbackRemaining = usedPercent === null ? null : 100 - usedPercent;
    const remainingPercent = clampPercent(numberOrNull(window?.remainingPercent ?? window?.percent) ?? fallbackRemaining);
    return {
      kind: String(window?.kind || ""),
      label: String(window?.label || ""),
      windowMinutes: numberOrNull(window?.windowMinutes),
      usedPercent,
      remainingPercent,
      resetAt: window?.resetAt || null,
      resetText: String(window?.resetText || "--")
    };
  }).filter((window) => window.remainingPercent !== null);
}

function buildCodexUsageWindows(rateLimits) {
  if (!rateLimits) return [];
  return [
    buildCodexUsageWindow("primary", rateLimits.primary),
    buildCodexUsageWindow("secondary", rateLimits.secondary)
  ].filter(Boolean);
}

function buildCodexUsageWindow(kind, limit) {
  const usedPercent = numberOrNull(limit?.used_percent);
  if (usedPercent === null) return null;

  const windowMinutes = numberOrNull(limit?.window_minutes);
  const resetsAt = numberOrNull(limit?.resets_at);

  return {
    kind,
    label: formatWindowLabel(windowMinutes, kind),
    windowMinutes,
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    resetAt: timestampFromSeconds(resetsAt),
    resetText: formatResetText(resetsAt)
  };
}

function formatWindowLabel(windowMinutes, kind) {
  const minutes = numberOrNull(windowMinutes);
  if (!minutes) return kind === "secondary" ? "1w" : "5h";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatResetText(seconds) {
  const resetSeconds = numberOrNull(seconds);
  if (resetSeconds === null) return "--";

  const resetMs = resetSeconds * 1000;
  const deltaMinutes = Math.max(0, Math.ceil((resetMs - Date.now()) / 60000));
  if (deltaMinutes < 48 * 60) {
    const hours = Math.floor(deltaMinutes / 60);
    const minutes = deltaMinutes % 60;
    return `${pad2(hours)}:${pad2(minutes)}`;
  }

  const date = new Date(resetMs);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

async function listRecentJsonlFiles(root, limit) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;

      try {
        const info = await stat(path);
        files.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }));
  }

  await walk(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

async function readClaudeUsageSummary(file, weeklyCutoffMs) {
  const summary = { latest: null, weeklyUsed: 0, events: [] };

  try {
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const usage = entry?.message?.usage;
      if (!usage) continue;

      const timestampMs = Date.parse(entry.timestamp || "");
      const current = {
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
        cwd: entry.cwd || "",
        input: numberOrZero(usage.input_tokens),
        output: numberOrZero(usage.output_tokens),
        cacheCreation: numberOrZero(usage.cache_creation_input_tokens),
        cacheRead: numberOrZero(usage.cache_read_input_tokens)
      };
      const total = current.input + current.output + current.cacheCreation + current.cacheRead;
      summary.events.push({
        timestampMs: current.timestampMs,
        tokens: total
      });

      if (current.timestampMs >= weeklyCutoffMs) {
        summary.weeklyUsed += total;
      }
      if (!summary.latest || current.timestampMs > summary.latest.timestampMs) {
        summary.latest = current;
      }
    }
  } catch {
    return summary;
  }

  return summary;
}

function timestampFromSeconds(value) {
  const seconds = numberOrNull(value);
  if (seconds === null) return null;
  return new Date(seconds * 1000).toISOString();
}

function shortPath(value) {
  const home = os.homedir();
  if (value === home) return "~";
  if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}

function numberOrZero(value) {
  const number = numberOrNull(value);
  return number === null ? 0 : number;
}

function percentFromTokens(used, limit) {
  const tokenCount = numberOrNull(used);
  const tokenLimit = numberOrNull(limit);
  if (tokenCount === null || !tokenLimit) return null;
  return clampPercent((tokenCount / tokenLimit) * 100);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  if (value === null || value === undefined) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildAlerts({ cpuPercent, memoryPercent, battery, git, agents }) {
  const alerts = [];
  if (cpuPercent >= 85) alerts.push("CPU");
  if (memoryPercent >= 85) alerts.push("MEM");
  if (battery.available && battery.percent !== null && battery.percent <= 20 && !battery.charging) {
    alerts.push("BATT");
  }
  if (git.available && git.changed > 0) alerts.push("GIT");
  if (agents.codex.tokens.percent !== null && agents.codex.tokens.percent >= 85) alerts.push("CDX");
  if (agents.claude.tokens.percent !== null && agents.claude.tokens.percent >= 85) alerts.push("CLD");
  return alerts;
}

async function pasteIntoFocusedInput(text) {
  await execFileAsync("osascript", [
    "-e", "on run argv",
    "-e", "set the clipboard to item 1 of argv",
    "-e", "tell application \"System Events\" to keystroke \"v\" using command down",
    "-e", "end run",
    text
  ], { timeout: 5000 });
}

async function pressReturnInFocusedInput() {
  await execFileAsync("osascript", [
    "-e", "tell application \"System Events\" to key code 36"
  ], { timeout: 5000 });
}

function normalizeVoiceAgent(value) {
  const agent = String(value || "").toLowerCase();
  return agent === "claude" || agent === "claude-code" ? "claude" : "codex";
}

function sendJson(res, payload) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function sendLogo(filename, res) {
  const logo = logoFiles.get(filename);
  if (!logo) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "logo_not_found" }));
    return;
  }

  try {
    const data = await readFile(logo.path);
    res.writeHead(200, { "content-type": logo.type, "cache-control": "public, max-age=3600" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "logo_not_found" }));
  }
}

function getLocalAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function round(value, precision) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>StopWatch Monitor</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101318; color: #f4f7fb; }
    main { width: min(720px, calc(100vw - 32px)); }
    h1 { font-size: 28px; margin: 0 0 18px; font-weight: 650; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .card { border: 1px solid #29313d; border-radius: 8px; padding: 16px; background: #171c24; }
    .label { align-items: center; color: #8f9aaa; display: flex; font-size: 13px; gap: 8px; margin-bottom: 6px; }
    .logo { height: 22px; width: 22px; }
    .value { font-size: 34px; font-weight: 700; line-height: 1; }
    .wide { grid-column: 1 / -1; }
    code { color: #b7e1ca; }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>StopWatch Monitor</h1>
    <section class="grid">
      <div class="card"><div class="label">CPU</div><div class="value" id="cpu">--%</div></div>
      <div class="card"><div class="label">Memory</div><div class="value" id="mem">--%</div></div>
      <div class="card"><div class="label">Battery</div><div class="value" id="battery">--</div></div>
      <div class="card"><div class="label">Git changes</div><div class="value" id="git">--</div></div>
      <div class="card"><div class="label"><img class="logo" src="/logos/codex-color.svg" alt="" />Codex tokens / task</div><div class="value" id="codex">--</div></div>
      <div class="card"><div class="label"><img class="logo" src="/logos/claudecode-color.svg" alt="" />Claude Code tokens / task</div><div class="value" id="claude">--</div></div>
      <div class="card wide"><div class="label">Device URL</div><code id="ws"></code></div>
    </section>
  </main>
  <script>
    const wsUrl = "ws://" + location.host + "/client";
    document.getElementById("ws").textContent = wsUrl.replace("/client", "/device");
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      const status = payload.status || payload;
      document.getElementById("cpu").textContent = status.cpu.percent + "%";
      document.getElementById("mem").textContent = status.memory.percent + "%";
      document.getElementById("battery").textContent = status.battery.available ? status.battery.percent + "%" : "n/a";
      document.getElementById("git").textContent = status.git.available ? status.git.changed : "n/a";
      document.getElementById("codex").textContent = formatAgent(status.agents.codex);
      document.getElementById("claude").textContent = formatAgent(status.agents.claude);
    };
    function formatAgent(agent) {
      const token = formatTokenCount(agent.trends && agent.trends.usage && agent.trends.usage.total);
      const weekly = formatTokenCount(agent.trends && agent.trends.weekly && agent.trends.weekly.total);
      if (agent.usageWindows && agent.usageWindows.length) {
        const windows = agent.usageWindows.map((window) => {
          const percent = window.remainingPercent === null ? "--" : window.remainingPercent + "%";
          return window.label + " " + percent + " " + window.resetText;
        }).join(" / ");
        return windows + " / usage " + token + " / weekly " + weekly;
      }
      return "usage " + token + " / weekly " + weekly;
    }
    function formatTokenCount(value) {
      if (value === null || value === undefined) return "--";
      if (value >= 1e9) return (value / 1e9).toFixed(value >= 1e10 ? 0 : 1) + "B";
      if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + "M";
      if (value >= 1e3) return (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) + "K";
      return String(value);
    }
  </script>
</body>
</html>`;
}
