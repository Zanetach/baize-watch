import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const serviceLabel = "com.zane.stopwatch-monitor";

export function serviceDefaults({
  home = os.homedir(),
  packageRoot: root = packageRoot,
  nodePath = process.execPath
} = {}) {
  const configDir = path.join(home, ".stopwatch-monitor");
  return {
    label: serviceLabel,
    packageRoot: root,
    nodePath,
    cliPath: path.join(root, "bin", "stopwatch-monitor.js"),
    configDir,
    envFile: path.join(configDir, "env"),
    agentStatusFile: path.join(configDir, "agent-status.json"),
    plistPath: path.join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`),
    stdoutPath: path.join(configDir, "stopwatch-monitor.log"),
    stderrPath: path.join(configDir, "stopwatch-monitor.err.log")
  };
}

export function buildDefaultEnvFile({ apiKey = process.env.DASHSCOPE_API_KEY || "" } = {}) {
  const lines = [
    "MONITOR_STT_PROVIDER=doubao-native",
    "MONITOR_DOUBAO_NATIVE_ASR_MODEL=bigmodel",
    "MONITOR_DOUBAO_NATIVE_ASR_RESOURCE_ID=volc.seedasr.sauc.duration",
    "MONITOR_DOUBAO_NATIVE_ASR_CHUNK_INTERVAL_MS=0",
    "# DOUBAO_ASR_APP_ID=your-app-id",
    "# DOUBAO_ASR_ACCESS_TOKEN=your-access-token",
    "MONITOR_STATUS_SLOW_CACHE_MS=5000",
    "MONITOR_ASSISTANT_ENABLED=1",
    "MONITOR_FOCUSED_DICTATION=1",
    "MONITOR_TTS_PROVIDER=aliyun",
    "MONITOR_ALIYUN_TTS_MODEL=cosyvoice-v3-flash",
    "MONITOR_ALIYUN_TTS_VOICE=longwanjun_v3",
    "MONITOR_ALIYUN_TTS_SAMPLE_RATE=16000",
    "MONITOR_ALIYUN_TTS_VOLUME=100",
    "MONITOR_TTS_CHUNK_BYTES=4096",
    "MONITOR_TTS_GAIN=4.8",
    "MONITOR_DEVICE_WAKE_CUE=0",
    "MONITOR_WAKE_GREETING=我是傻妞，你的智能秘书。",
    "MONITOR_WAKE_TTS_VOLUME=100",
    "MONITOR_WAKE_TTS_GAIN=4.8",
    "MONITOR_ASSISTANT_PROVIDER=aliyun",
    "MONITOR_ASSISTANT_MODEL=qwen-plus",
    "MONITOR_ASSISTANT_MAX_TOKENS=40",
    "# Optional Aliyun STT fallback:",
    "# MONITOR_STT_PROVIDER=aliyun",
    "# MONITOR_ALIYUN_ASR_MODEL=qwen3-asr-flash-realtime",
    "# MONITOR_ALIYUN_FALLBACK_MODEL=fun-asr-realtime",
    "# MONITOR_ALIYUN_ASR_PROTOCOL=auto",
    "# MONITOR_ALIYUN_CHUNK_INTERVAL_MS=0",
    "# MONITOR_ALIYUN_VOCABULARY_ID=vocab-your-hotwords",
    "# Optional Doubao Realtime API gateway fallback:",
    "# MONITOR_STT_PROVIDER=doubao",
    "# MONITOR_DOUBAO_ASR_MODEL=bigmodel",
    "# MONITOR_DOUBAO_ASR_RESOURCE_ID=volc.bigasr.sauc.duration",
    "# MONITOR_DOUBAO_ASR_CHUNK_INTERVAL_MS=0",
    "# DOUBAO_ASR_API_KEY=apikey-your-gateway-key",
    "# Optional Doubao assistant fallback:",
    "# DOUBAO_CHAT_API_KEY=ark-...",
    "# DOUBAO_CHAT_MODEL=doubao-seed-1-6-flash-250615",
    "# Optional Doubao speech TTS fallback:",
    "# MONITOR_TTS_PROVIDER=doubao",
    "# MONITOR_DOUBAO_TTS_PROTOCOL=speech",
    "# MONITOR_DOUBAO_TTS_RESOURCE_ID=seed-tts-2.0",
    "# DOUBAO_TTS_API_KEY=your-doubao-speech-api-key",
    "# DOUBAO_TTS_VOICE=zh_female_jiaochuannv_uranus_bigtts",
    "# DOUBAO_TTS_SAMPLE_RATE=16000",
    "# Optional legacy Doubao AI Gateway TTS:",
    "# MONITOR_DOUBAO_TTS_PROTOCOL=gateway",
    "# DOUBAO_TTS_MODEL=doubao-tts"
  ];

  if (apiKey) {
    lines.push(`DOUBAO_ASR_ACCESS_TOKEN=${apiKey}`);
  }

  return `${lines.join("\n")}\n`;
}

export function buildLaunchAgentPlist(paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(paths.nodePath)}</string>
    <string>${escapeXml(paths.cliPath)}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(paths.packageRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STOPWATCH_MONITOR_ENV</key>
    <string>${escapeXml(paths.envFile)}</string>
    <key>MONITOR_AGENT_STATUS_FILE</key>
    <string>${escapeXml(paths.agentStatusFile)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const command = argv[0] || "help";
  const paths = serviceDefaults(deps.paths);
  const io = deps.io || console;
  const run = deps.execFile || execFile;
  const platform = deps.platform || process.platform;

  if (command === "start") {
    await loadRuntimeEnv(paths);
    const port = Number.parseInt(process.env.MONITOR_PORT || "8787", 10);
    const portInUse = Number.isFinite(port) && port > 0
      ? await (deps.isPortListening || isTcpPortListening)(port)
      : false;
    if (portInUse) {
      io.log(`Baize Watch monitor is already running on port ${port}.`);
      io.log(`Browser preview: http://localhost:${port}`);
      io.log("Use `stopwatch-monitor restart` to reload the background service.");
      return 0;
    }
    await (deps.importServer || importServer)();
    return 0;
  }

  if (command === "install") {
    await installService({ paths, run, platform, io });
    return 0;
  }

  if (command === "uninstall") {
    await uninstallService({ paths, run, platform, io });
    return 0;
  }

  if (command === "restart") {
    await requireMacOS(platform);
    await run("launchctl", ["kickstart", "-k", serviceTarget(paths)]);
    io.log(`Restarted ${paths.label}`);
    return 0;
  }

  if (command === "stop") {
    await requireMacOS(platform);
    await bootoutService(paths, run);
    io.log(`Stopped ${paths.label}`);
    return 0;
  }

  if (command === "status") {
    await requireMacOS(platform);
    const result = await run("launchctl", ["print", serviceTarget(paths)]);
    io.log(result.stdout || "");
    return 0;
  }

  if (command === "logs") {
    io.log(`stdout: ${paths.stdoutPath}`);
    io.log(`stderr: ${paths.stderrPath}`);
    return 0;
  }

  io.log(helpText());
  return command === "help" || command === "--help" || command === "-h" ? 0 : 1;
}

async function installService({ paths, run, platform, io }) {
  await requireMacOS(platform);
  await mkdir(paths.configDir, { recursive: true });
  await mkdir(path.dirname(paths.plistPath), { recursive: true });

  if (!existsSync(paths.envFile)) {
    await writeFile(paths.envFile, buildDefaultEnvFile(), { mode: 0o600 });
  }

  if (!existsSync(paths.agentStatusFile)) {
    await writeFile(paths.agentStatusFile, "{}\n", { mode: 0o600 });
  }

  await writeFile(paths.plistPath, buildLaunchAgentPlist(paths), { mode: 0o644 });
  await bootoutService(paths, run);
  await run("launchctl", ["bootstrap", userDomain(), paths.plistPath]);
  await run("launchctl", ["enable", serviceTarget(paths)]);
  await run("launchctl", ["kickstart", "-k", serviceTarget(paths)]);

  io.log(`Installed ${paths.label}`);
  io.log(`Config: ${paths.envFile}`);
  io.log(`Logs: ${paths.stdoutPath}`);
}

async function uninstallService({ paths, run, platform, io }) {
  await requireMacOS(platform);
  await bootoutService(paths, run);
  if (existsSync(paths.plistPath)) {
    await unlink(paths.plistPath);
  }
  io.log(`Uninstalled ${paths.label}`);
}

async function loadRuntimeEnv(paths) {
  await loadEnvFile(process.env.STOPWATCH_MONITOR_ENV || paths.envFile);
  await loadEnvFile(path.join(paths.packageRoot, ".env.local"));
  process.env.MONITOR_AGENT_STATUS_FILE ||= paths.agentStatusFile;
}

async function loadEnvFile(file) {
  try {
    const raw = await readFile(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      process.env[key] ||= value;
    }
  } catch {
    // Missing env files are valid for status-only monitor usage.
  }
}

async function bootoutService(paths, run) {
  try {
    await run("launchctl", ["bootout", userDomain(), paths.plistPath]);
  } catch {
    // launchctl returns an error when the service is not loaded; install/uninstall can continue.
  }
}

async function requireMacOS(platform) {
  if (platform !== "darwin") {
    throw new Error("Background service install is currently supported on macOS LaunchAgent only.");
  }
}

export function isTcpPortListening(port, { host = "127.0.0.1", timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(timeoutMs, () => settle(false));
  });
}

function importServer() {
  return import("./index.js");
}

function userDomain() {
  return `gui/${process.getuid()}`;
}

function serviceTarget(paths) {
  return `${userDomain()}/${paths.label}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function helpText() {
  return `Baize Watch monitor

Usage:
  stopwatch-monitor start       Run the desktop monitor in the foreground
  stopwatch-monitor install     Install and start the macOS background service
  stopwatch-monitor restart     Restart the background service
  stopwatch-monitor stop        Stop the background service
  stopwatch-monitor status      Print launchd service status
  stopwatch-monitor logs        Print log file paths
  stopwatch-monitor uninstall   Remove the background service
`;
}
