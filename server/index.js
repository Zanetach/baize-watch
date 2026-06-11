import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { createAssistantResponder } from "./assistant.js";
import {
  isConversationVoiceMode,
  normalizeVoiceMode,
  normalizeVoiceAgent,
  shouldAcceptVoiceStart,
  shouldAcceptVoiceWake,
  shouldExitConversation,
  shouldPasteRecognizedSpeech,
  shouldRepromptAfterEmptyTranscript,
  shouldSilenceFocusedDictation,
  shouldUseDeviceWakeCue,
  speechOptionsForAssistantStatus,
  voiceStatusWithAssistantProcessing,
  wakeGreetingText,
  wakeSpeechOptions
} from "./assistant-session.js";
import { sendPcmSpeechToDevices } from "./device-audio.js";
import { createVoiceController } from "./voice.js";
import { bucketTokenTrend, normalizeTokenTrend } from "./trends.js";
import { createTranscribeAudio, resolveSttProvider } from "./stt.js";
import {
  createAliyunTtsSynthesizer,
  createCachedSpeechSynthesizer,
  createDoubaoTtsSynthesizer
} from "./tts.js";
import { createSingleFlightTtlCache } from "./status-cache.js";
import { readClaudeStatusLineSnapshot } from "./claude-statusline.js";
import { isBetterCodexRateLimitEntry } from "./codex-rate-limits.js";
import { buildClaudeUsageWindows, buildCodexUsageWindows, buildRollingUsageWindows } from "./usage-windows.js";
import { agentFreshness } from "./agent-freshness.js";
import { activationNameForTargetApp, buildPasteScript } from "./app-targets.js";
import {
  buildFocusedInputProbeScript,
  isFocusedTextInput,
  parseFocusedInputProbe
} from "./focused-input.js";
import {
  createDiscoveryResponder,
  getLocalAddresses
} from "./discovery.js";

const execFileAsync = promisify(execFile);
const defaultAgentStatusFile = fileURLToPath(new URL("./agent-status.json", import.meta.url));
const logoFiles = new Map([
  ["codex-color.svg", { path: fileURLToPath(new URL("./public/logos/codex-color.svg", import.meta.url)), type: "image/svg+xml" }],
  ["claudecode-color.svg", { path: fileURLToPath(new URL("./public/logos/claudecode-color.svg", import.meta.url)), type: "image/svg+xml" }],
  ["codex-color.png", { path: fileURLToPath(new URL("./public/logos/codex-color.png", import.meta.url)), type: "image/png" }],
  ["claudecode-color.png", { path: fileURLToPath(new URL("./public/logos/claudecode-color.png", import.meta.url)), type: "image/png" }]
]);

const port = Number.parseInt(process.env.MONITOR_PORT || "8787", 10);
const discoveryPort = Number.parseInt(process.env.MONITOR_DISCOVERY_PORT || "8788", 10);
const label = process.env.MONITOR_LABEL || os.hostname();
const gitRepo = process.env.MONITOR_GIT_REPO || process.cwd();
const intervalMs = Number.parseInt(process.env.MONITOR_INTERVAL_MS || "1000", 10);
const agentStatusFile = process.env.MONITOR_AGENT_STATUS_FILE || defaultAgentStatusFile;
const codexStateDb = process.env.MONITOR_CODEX_STATE_DB || `${os.homedir()}/.codex/state_5.sqlite`;
const codexSessionsDir = process.env.MONITOR_CODEX_SESSIONS_DIR || `${os.homedir()}/.codex/sessions`;
const claudeProjectsDir = process.env.MONITOR_CLAUDE_PROJECTS_DIR || `${os.homedir()}/.claude/projects`;
const claudeStatusLineFile = process.env.MONITOR_CLAUDE_STATUSLINE_FILE || `${os.homedir()}/.baize-watch/claude-statusline.json`;
const codexTokenLimit = Number.parseInt(process.env.MONITOR_CODEX_TOKEN_LIMIT || "200000000", 10);
const claudeTokenLimit = Number.parseInt(process.env.MONITOR_CLAUDE_TOKEN_LIMIT || "200000", 10);
const codexWeeklyTokenLimit = Number.parseInt(process.env.MONITOR_CODEX_WEEKLY_TOKEN_LIMIT || "5000000000", 10);
const claudeWeeklyTokenLimit = Number.parseInt(process.env.MONITOR_CLAUDE_WEEKLY_TOKEN_LIMIT || "50000000", 10);
const codexRateLimitCacheMs = 15000;
const slowStatusCacheMs = Number.parseInt(process.env.MONITOR_STATUS_SLOW_CACHE_MS || "5000", 10);
const sttModel = process.env.MONITOR_STT_MODEL || "gpt-4o-mini-transcribe";
const sttProvider = resolveSttProvider(process.env);
const voiceGain = Number.parseFloat(process.env.MONITOR_VOICE_GAIN || "1.35");
const voiceMinRecordingMs = Number.parseInt(process.env.MONITOR_VOICE_MIN_RECORDING_MS || "900", 10);
const voiceMinRms = Number.parseInt(process.env.MONITOR_VOICE_MIN_RMS || "0", 10);
const voiceDebugAudioDir = String(process.env.MONITOR_VOICE_DEBUG_AUDIO_DIR || "").trim();
const assistantEnabled = parseBooleanEnv(process.env.MONITOR_ASSISTANT_ENABLED, true);
const focusedDictationEnabled = parseBooleanEnv(process.env.MONITOR_FOCUSED_DICTATION, true);
const ttsProvider = String(process.env.MONITOR_TTS_PROVIDER || "aliyun").trim().toLowerCase();
const ttsChunkBytes = Number.parseInt(process.env.MONITOR_TTS_CHUNK_BYTES || "4096", 10);
const ttsGain = Number.parseFloat(process.env.MONITOR_TTS_GAIN || "4.8");
const wakeTtsGain = Number.parseFloat(process.env.MONITOR_WAKE_TTS_GAIN || "4.8");
const wakeTtsVolume = Number.parseInt(process.env.MONITOR_WAKE_TTS_VOLUME || "100", 10);
const deviceWakeCue = shouldUseDeviceWakeCue(process.env);
const conversationWakeEnabled = parseBooleanEnv(process.env.MONITOR_CONVERSATION_WAKE_ENABLED, false);
const displayTimeZone = process.env.MONITOR_DISPLAY_TIME_ZONE ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  "Asia/Shanghai";
const configuredAgentStaleAfterMs = Number.parseInt(process.env.MONITOR_AGENT_STALE_AFTER_MS || "", 10);
const agentStaleAfterMs = Number.isFinite(configuredAgentStaleAfterMs) && configuredAgentStaleAfterMs > 0
  ? configuredAgentStaleAfterMs
  : 2 * 60 * 60 * 1000;
const usageTrendWindowMs = 5 * 60 * 60 * 1000;
const weeklyTrendWindowMs = 7 * 24 * 60 * 60 * 1000;
const trendBucketCount = 12;
const transcribeAudio = createTranscribeAudio({
  provider: sttProvider,
  openaiModel: sttModel,
  execFileAsync
});
const assistantResponder = createAssistantResponder();
const baseSynthesizeSpeech = createSpeechSynthesizer(ttsProvider);
const synthesizeSpeech = baseSynthesizeSpeech ? createCachedSpeechSynthesizer(baseSynthesizeSpeech) : null;

let lastCpuSample = sampleCpu();
let codexRateLimitCache = { expiresAt: 0, status: {} };
let deviceSpeechBusyUntilMs = 0;
let deviceSpeechInFlight = false;
let assistantTurnInFlight = false;
let voiceConversationActive = false;
let activeVoiceMode = "idle";
let voiceConversationTurns = [];
let assistantProcessing = { active: false, agent: "codex", startedAt: 0 };
const slowStatusCache = createSingleFlightTtlCache({
  ttlMs: Number.isFinite(slowStatusCacheMs) && slowStatusCacheMs > 0 ? slowStatusCacheMs : 5000,
  load: collectSlowStatus
});
const voice = createVoiceController({
  transcribeAudio,
  onTranscribeAudio: saveDebugVoiceAudio,
  pasteText: pasteIntoFocusedInput,
  pressReturn: pressReturnInFocusedInput,
  shouldPasteTranscript: shouldPasteVoiceTranscript,
  config: {
    gain: Number.isFinite(voiceGain) && voiceGain > 0 ? voiceGain : 1,
    minRecordingMs: Number.isFinite(voiceMinRecordingMs) && voiceMinRecordingMs > 0 ? voiceMinRecordingMs : 900,
    minRms: Number.isFinite(voiceMinRms) && voiceMinRms > 0 ? voiceMinRms : 0
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
    sendJson(res, { ...currentVoiceStatus(), provider: sttProvider });
    return;
  }

  if (url.pathname === "/speak" && req.method === "POST") {
    await handleSpeakRequest(req, res);
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
const discoveryResponder = createDiscoveryResponder({
  discoveryPort,
  monitorPort: port
});

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
  console.log(`Baize Watch monitor listening on port ${port}`);
  console.log(`Browser preview: http://localhost:${port}`);
  for (const address of addresses) {
    console.log(`Device WebSocket: ws://${address}:${port}/device`);
  }
  discoveryResponder.start();
  warmWakeSpeech();
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

  if (payload.type === "voice_wake") {
    const agent = normalizeVoiceAgent(payload.agent);
    const voiceStatus = voice.status();
    if (!shouldAcceptVoiceWake({
      voiceState: voiceStatus.state,
      nowMs: Date.now(),
      deviceSpeechBusyUntilMs,
      speechInFlight: deviceSpeechInFlight || assistantTurnInFlight
    })) {
      console.log(
        `[${new Date().toISOString()}] voice_wake_ignored ` +
        `agent=${agent} voiceState=${voiceStatus.state} busyUntil=${deviceSpeechBusyUntilMs}`
      );
      return;
    }
    if (deviceWakeCue) {
      voiceConversationActive = true;
      activeVoiceMode = "continue";
      resetVoiceConversation();
      console.log(`[${new Date().toISOString()}] voice_wake_local agent=${agent}`);
      return;
    }
    voiceConversationActive = true;
    activeVoiceMode = "continue";
    resetVoiceConversation();
    await speakToDevice(wakeGreetingText(), wakeSpeechOptions(agent));
    return;
  }

  if (payload.type === "voice_start") {
    const mode = normalizeVoiceMode(payload.mode);
    if (!shouldAcceptVoiceStart({
      mode,
      conversationActive: voiceConversationActive,
      nowMs: Date.now(),
      deviceSpeechBusyUntilMs,
      deviceSpeechInFlight,
      assistantTurnInFlight
    })) {
      console.log(
        `[${new Date().toISOString()}] voice_start_ignored ` +
        `agent=${normalizeVoiceAgent(payload.agent)} speechInFlight=${deviceSpeechInFlight} ` +
        `assistantInFlight=${assistantTurnInFlight} busyUntil=${deviceSpeechBusyUntilMs}`
      );
      return;
    }
    activeVoiceMode = mode;
    if (mode === "dictate") {
      voiceConversationActive = false;
      resetVoiceConversation();
    }
    voice.start({ agent: normalizeVoiceAgent(payload.agent) });
    await publishStatus();
    return;
  }

  if (payload.type === "voice_exit") {
    voiceConversationActive = false;
    activeVoiceMode = "idle";
    voice.cancel();
    resetVoiceConversation();
    console.log(`[${new Date().toISOString()}] voice_session_exit agent=${normalizeVoiceAgent(payload.agent)}`);
    await publishStatus();
    return;
  }

  if (payload.type === "voice_stop") {
    const mode = activeVoiceMode;
    const conversationActive = isConversationVoiceMode({
      mode,
      conversationActive: voiceConversationActive
    });
    const status = await voice.stop();
    activeVoiceMode = "idle";
    logVoiceStop(status);
    await publishStatus();
    void handleAssistantTurn(status, { conversationActive }).catch((caught) => {
      console.error(`[${new Date().toISOString()}] assistant_turn_failed`, caught);
    });
    return;
  }

  if (payload.type === "voice_export") {
    activeVoiceMode = "idle";
    await exportVoiceConversation(normalizeVoiceAgent(payload.agent));
    return;
  }

  if (payload.type === "voice_send") {
    const before = voice.status();
    await voice.send();
    if (before.intent?.action === "conversation_export") {
      resetVoiceConversation();
    }
    await publishStatus();
  }
}

function logVoiceStop(status) {
  const audio = status.audio || {};
  console.log(
    `[${new Date().toISOString()}] voice_stop_result ` +
    `agent=${status.agent} state=${status.state} durationMs=${audio.durationMs ?? 0} ` +
    `bytes=${audio.bytes ?? 0} rms=${audio.rms ?? 0} peak=${audio.peak ?? 0} ` +
    `asrMs=${status.asr?.latencyMs ?? "-"} ` +
    `clipped=${audio.clippedSamples ?? 0} textChars=${String(status.text || "").length} ` +
    `text=${JSON.stringify(clipLogText(status.text))} ` +
    `error=${status.error || ""}`
  );
}

async function saveDebugVoiceAudio(audio, metadata = {}) {
  if (!voiceDebugAudioDir) return;
  try {
    await mkdir(voiceDebugAudioDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const agent = normalizeVoiceAgent(metadata.agent);
    const file = `${voiceDebugAudioDir}/${stamp}-${agent}.wav`;
    await writeFile(file, audio);
    console.log(
      `[${new Date().toISOString()}] voice_debug_audio_saved ` +
      `file=${file} bytes=${audio.length} durationMs=${metadata.audio?.durationMs ?? 0} ` +
      `rms=${metadata.audio?.rms ?? 0} peak=${metadata.audio?.peak ?? 0}`
    );
  } catch (caught) {
    console.error(`[${new Date().toISOString()}] voice_debug_audio_failed`, caught);
  }
}

async function publishStatus() {
  latestStatus = await collectStatus();
  broadcast({ type: "status", status: latestStatus });
}

async function handleSpeakRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const text = String(body.text || "").trim();
    if (!text) {
      sendJson(res, { error: "text_required" }, 400);
      return;
    }
    const result = await speakToDevice(text);
    sendJson(res, result);
  } catch (caught) {
    sendJson(res, { error: caught instanceof Error ? caught.message : String(caught) }, 500);
  }
}

async function handleAssistantTurn(status, { conversationActive = false } = {}) {
  if (!assistantEnabled) return;
  assistantTurnInFlight = true;
  try {
    if (!conversationActive) {
      return;
    }

    if (!status?.text) {
      if (shouldRepromptAfterEmptyTranscript(status, { conversationActive })) {
        await speakToDevice("我没听清，再说一遍。", {
          agent: status?.agent,
          after: "listen"
        });
      } else if (conversationActive && ["empty", "too_short", "too_quiet", "error"].includes(status?.state)) {
        await speakToDevice("我没有听清，再说一次。", {
          agent: status?.agent,
          after: "listen"
        });
      }
      return;
    }

    if (conversationActive) {
      addVoiceConversationTurn("user", status.text);
    }
    console.log(
      `[${new Date().toISOString()}] assistant_heard ` +
      `agent=${status.agent} text=${JSON.stringify(clipLogText(status.text))} action=${status.intent?.action || "unknown"}`
    );

    if (shouldExitConversation(status.intent)) {
      resetVoiceConversation();
      console.log(
        `[${new Date().toISOString()}] voice_session_exit_by_speech ` +
        `agent=${status.agent} text=${JSON.stringify(clipLogText(status.text))}`
      );
      await speakToDevice("已退出对话。", {
        agent: status.agent,
        after: "idle"
      });
      return;
    }

    if (shouldSilenceFocusedDictation(status)) {
      return;
    }

    const assistantStartedAt = Date.now();
    assistantProcessing = {
      active: true,
      agent: normalizeVoiceAgent(status.agent),
      startedAt: assistantStartedAt
    };
    await publishStatus();
    const reply = await assistantResponder({
      text: status.text,
      agent: status.agent,
      intent: status.intent,
      preparedForAgent: status.preparedForAgent,
      history: voiceConversationTurns
    });
    const assistantMs = Date.now() - assistantStartedAt;
    console.log(
      `[${new Date().toISOString()}] assistant_reply ` +
      `agent=${status.agent} source=${reply.source} chatMs=${assistantMs} ` +
      `text=${JSON.stringify(reply.text)} error=${reply.error || ""}`
    );
    if (conversationActive) {
      addVoiceConversationTurn("assistant", reply.text);
    }
    await speakToDevice(reply.text, speechOptionsForAssistantStatus(status));
  } catch (caught) {
    console.error(`[${new Date().toISOString()}] assistant_turn_failed`, caught);
  } finally {
    assistantProcessing = { active: false, agent: "codex", startedAt: 0 };
    assistantTurnInFlight = false;
  }
}

async function exportVoiceConversation(agent = "codex") {
  const transcript = formatVoiceConversationTranscript(voiceConversationTurns);
  voiceConversationActive = false;
  voice.cancel();
  if (!transcript) {
    await publishStatus();
    return;
  }

  const status = await voice.prepareText(transcript, {
    agent,
    intent: { action: "conversation_export" }
  });
  console.log(
    `[${new Date().toISOString()}] voice_conversation_export ` +
    `agent=${status.agent} chars=${transcript.length} turns=${voiceConversationTurns.length}`
  );
  await publishStatus();
}

function resetVoiceConversation() {
  voiceConversationTurns = [];
}

function addVoiceConversationTurn(role, text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return;
  voiceConversationTurns.push({
    role: role === "assistant" ? "assistant" : "user",
    text: normalized
  });
}

function formatVoiceConversationTranscript(turns = []) {
  return turns
    .map((turn) => `${turn.role === "assistant" ? "傻妞" : "我"}：${turn.text}`)
    .join("\n")
    .trim();
}

function clipLogText(text, maxChars = 80) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, maxChars).join("")}...`;
}

async function speakToDevice(text, speechOptions = {}) {
  if (!synthesizeSpeech) {
    throw new Error(`Unsupported TTS provider: ${ttsProvider}`);
  }
  deviceSpeechInFlight = true;
  const startedAt = Date.now();
  try {
    const wakeProfile = speechOptions.profile === "wake";
    const selectedGain = wakeProfile && Number.isFinite(wakeTtsGain) && wakeTtsGain > 0
      ? wakeTtsGain
      : (Number.isFinite(ttsGain) && ttsGain > 0 ? ttsGain : 1);
    const synthesizeOptions = wakeProfile && Number.isFinite(wakeTtsVolume) && wakeTtsVolume > 0
      ? { volume: wakeTtsVolume }
      : {};
    if (wakeProfile) {
      synthesizeOptions.cacheKey = wakeSpeechCacheKey(text, synthesizeOptions);
    }
    const speech = await synthesizeSpeech(text, synthesizeOptions);
    const synthMs = Date.now() - startedAt;
    const sendStartedAt = Date.now();
    const devices = sendPcmSpeechToDevices(clients, {
      ...speech,
      text
    }, {
      chunkBytes: Number.isFinite(ttsChunkBytes) && ttsChunkBytes > 0 ? ttsChunkBytes : 4096,
      gain: selectedGain,
      after: speechOptions.after,
      agent: speechOptions.agent
    });
    const sendMs = Date.now() - sendStartedAt;
    if (devices > 0) {
      deviceSpeechBusyUntilMs = Math.max(
        deviceSpeechBusyUntilMs,
        Date.now() + estimateSpeechDurationMs(speech) + 600
      );
    }
    console.log(
      `[${new Date().toISOString()}] tts_sent devices=${devices} bytes=${speech.audio.length} ` +
      `sampleRate=${speech.sampleRate} gain=${selectedGain} profile=${speechOptions.profile || "default"} ` +
      `after=${speechOptions.after || "idle"} agent=${speechOptions.agent || ""} ` +
      `synthMs=${synthMs} sendMs=${sendMs} totalMs=${Date.now() - startedAt} text=${JSON.stringify(text)}`
    );
    return { ok: true, devices, bytes: speech.audio.length, sampleRate: speech.sampleRate, format: speech.format, text };
  } finally {
    deviceSpeechInFlight = false;
  }
}

function warmWakeSpeech() {
  if (deviceWakeCue || !synthesizeSpeech) return;
  const text = wakeGreetingText();
  const options = Number.isFinite(wakeTtsVolume) && wakeTtsVolume > 0
    ? { volume: wakeTtsVolume }
    : {};
  options.cacheKey = wakeSpeechCacheKey(text, options);
  void synthesizeSpeech(text, options)
    .then((speech) => {
      console.log(
        `[${new Date().toISOString()}] wake_tts_warmed ` +
        `bytes=${speech.audio?.length ?? 0} sampleRate=${speech.sampleRate ?? ""}`
      );
    })
    .catch((caught) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      console.warn(`[${new Date().toISOString()}] wake_tts_warm_failed ${message}`);
    });
}

function wakeSpeechCacheKey(text, options = {}) {
  return JSON.stringify({
    provider: ttsProvider,
    profile: "wake",
    text: String(text || ""),
    volume: options.volume || ""
  });
}

function estimateSpeechDurationMs({ audio, sampleRate, format }) {
  if (format !== "pcm_s16le" || !sampleRate) return 0;
  const bytes = Buffer.isBuffer(audio) ? audio.length : Buffer.byteLength(audio || "");
  return Math.ceil((bytes / 2 / sampleRate) * 1000);
}

function parseBooleanEnv(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function createSpeechSynthesizer(provider) {
  if (provider === "aliyun") return createAliyunTtsSynthesizer();
  if (provider === "doubao") return createDoubaoTtsSynthesizer();
  return null;
}

function currentVoiceStatus() {
  return voiceStatusWithAssistantProcessing(voice.status(), {
    ...assistantProcessing,
    nowMs: Date.now()
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function collectStatus() {
  const { battery, git, memory, agents } = await slowStatusCache.get();
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
    voice: { ...currentVoiceStatus(), provider: sttProvider, deviceWakeCue, conversationWakeEnabled },
    alerts: buildAlerts({ cpuPercent, memoryPercent: memory.percent, battery, git, agents })
  };
}

async function collectSlowStatus() {
  const [battery, git, memory, agents] = await Promise.all([
    getBattery(),
    getGitStatus(),
    getMemory(),
    getAgents()
  ]);

  return {
    battery,
    git,
    memory,
    agents,
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
      if (isBetterCodexRateLimitEntry(entry, newest)) {
        newest = entry;
      }
    }

    const usageWindows = buildCodexUsageWindows(newest?.rateLimits, { timeZone: displayTimeZone });
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
    let best = null;

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
      const candidate = {
        rateLimits,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0
      };
      if (isBetterCodexRateLimitEntry(candidate, best)) {
        best = candidate;
      }
      if (String(rateLimits.limit_id || "").toLowerCase() === "codex") {
        return best;
      }
    }

    return best;
  } catch {
    return null;
  }

  return null;
}

async function readClaudeTokenStatus() {
  if (process.platform !== "darwin") return {};

  try {
    const [files, officialStatus] = await Promise.all([
      listRecentJsonlFiles(claudeProjectsDir, 30),
      readClaudeOfficialStatusLineStatus()
    ]);
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

    if (!newest && officialStatus.usageWindows?.length) {
      return {
        state: "online",
        task: officialStatus.task || "",
        progress: officialStatus.progress,
        usageWindows: officialStatus.usageWindows,
        updatedAt: officialStatus.updatedAt
      };
    }

    const nowMs = Date.now();
    const usagePoints = bucketTokenTrend(trendEvents, {
      nowMs,
      windowMs: usageTrendWindowMs,
      bucketCount: trendBucketCount
    });
    const weeklyPoints = bucketTokenTrend(trendEvents, {
      nowMs,
      windowMs: weeklyTrendWindowMs,
      bucketCount: trendBucketCount
    });

    if (!newest) return {};
    const latestUsed = newest.input + newest.output + newest.cacheCreation + newest.cacheRead;
    const usageUsed = sumTokenPoints(usagePoints);
    const rollingUsageWindows = buildRollingUsageWindows({
      primaryUsed: usageUsed,
      primaryLimit: claudeTokenLimit,
      secondaryUsed: weeklyUsed,
      secondaryLimit: claudeWeeklyTokenLimit
    });
    const usageWindows = officialStatus.usageWindows?.length
      ? officialStatus.usageWindows
      : rollingUsageWindows;

    return {
      state: "online",
      task: officialStatus.task || (newest.cwd ? shortPath(newest.cwd) : ""),
      progress: officialStatus.progress ?? percentFromTokens(weeklyUsed, claudeWeeklyTokenLimit),
      tokens: {
        used: usageUsed || latestUsed,
        limit: claudeTokenLimit
      },
      trends: {
        usage: normalizeTokenTrend({
          total: usageUsed,
          points: usagePoints
        }, usageUsed, trendBucketCount),
        weekly: normalizeTokenTrend({
          total: weeklyUsed,
          points: weeklyPoints
        }, weeklyUsed, trendBucketCount)
      },
      usageWindows,
      updatedAt: officialStatus.updatedAt || new Date(newest.timestampMs).toISOString()
    };
  } catch {
    return {};
  }
}

async function readClaudeOfficialStatusLineStatus() {
  const snapshot = await readClaudeStatusLineSnapshot(claudeStatusLineFile);
  const usageWindows = buildClaudeUsageWindows(snapshot?.rateLimits, { timeZone: displayTimeZone });
  if (!usageWindows.length) return {};

  return {
    task: snapshot?.cwd ? shortPath(snapshot.cwd) : "",
    progress: usageWindows[1]?.usedPercent ?? usageWindows[0]?.usedPercent ?? null,
    usageWindows,
    updatedAt: snapshot?.capturedAt || null
  };
}

function sumTokenPoints(points) {
  return (points || []).reduce((sum, value) => sum + numberOrZero(value), 0);
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
  const updatedAt = raw.updatedAt || raw.lastUpdated || null;
  const freshness = agentFreshness(updatedAt, { staleAfterMs: agentStaleAfterMs });
  const hasRawData = Boolean(Object.keys(raw).length);

  return {
    name,
    online,
    state: freshness.stale && hasRawData ? "stale" : String(raw.state || (online ? "online" : "offline")),
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
    updatedAt,
    stale: freshness.stale,
    freshness,
    source: {
      file: Boolean(Object.keys(raw).length),
      process: processOnline,
      dataFresh: !freshness.stale
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

async function pasteIntoFocusedInput(text, context = {}) {
  const targetApp = activationNameForTargetApp(
    context?.intent?.targetApp || context?.intent?.targetAgent || ""
  );
  await execFileAsync("osascript", [
    ...buildPasteScript(),
    text,
    targetApp
  ], { timeout: 5000 });
}

async function shouldPasteVoiceTranscript({ intent }) {
  const conversationActive = isConversationVoiceMode({
    mode: activeVoiceMode,
    conversationActive: voiceConversationActive
  });
  const needsFocusedProbe = assistantEnabled && focusedDictationEnabled && !conversationActive;
  const focusedTextInput = needsFocusedProbe ? await hasFocusedTextInput() : false;
  return shouldPasteRecognizedSpeech({
    assistantEnabled,
    focusedDictationEnabled,
    focusedTextInput,
    conversationActive,
    intent
  });
}

async function hasFocusedTextInput() {
  try {
    const { stdout } = await execFileAsync("osascript", buildFocusedInputProbeScript(), { timeout: 1200 });
    const info = parseFocusedInputProbe(stdout);
    const focused = isFocusedTextInput(info);
    if (focused) {
      console.log(
        `[${new Date().toISOString()}] focused_dictation_target ` +
        `app=${JSON.stringify(info.app)} role=${JSON.stringify(info.role)} ` +
        `description=${JSON.stringify(info.description)}`
      );
    }
    return focused;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.warn(`[${new Date().toISOString()}] focused_input_probe_failed ${message}`);
    return false;
  }
}

async function pressReturnInFocusedInput() {
  await execFileAsync("osascript", [
    "-e", "tell application \"System Events\" to key code 36"
  ], { timeout: 5000 });
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
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
  <title>Baize Watch</title>
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
    <h1>Baize Watch</h1>
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
