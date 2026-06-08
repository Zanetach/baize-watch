import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
    "MONITOR_STT_PROVIDER=aliyun",
    "MONITOR_ALIYUN_ASR_MODEL=qwen3-asr-flash-realtime",
    "MONITOR_ALIYUN_FALLBACK_MODEL=fun-asr-realtime",
    "MONITOR_ALIYUN_ASR_PROTOCOL=auto"
  ];

  if (apiKey) {
    lines.push(`DASHSCOPE_API_KEY=${apiKey}`);
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
    await import("./index.js");
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
  return `StopWatch desktop monitor

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
