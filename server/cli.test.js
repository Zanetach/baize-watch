import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package exposes an npx-friendly stopwatch-monitor command", () => {
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.bin?.["stopwatch-monitor"], "bin/stopwatch-monitor.js");
  assert.ok(packageJson.files?.includes("bin/"));
  assert.ok(packageJson.files?.includes("server/index.js"));
  assert.ok(packageJson.files?.includes("server/cli.js"));
  assert.ok(packageJson.files?.includes("server/public/"));
  assert.ok(existsSync(new URL("../bin/stopwatch-monitor.js", import.meta.url)));
});

test("CLI module builds a macOS LaunchAgent for background service mode", async () => {
  const { buildLaunchAgentPlist, serviceDefaults } = await import("./cli.js");
  const paths = serviceDefaults({
    home: "/Users/example",
    packageRoot: "/opt/stopwatch-monitor",
    nodePath: "/usr/local/bin/node"
  });

  const plist = buildLaunchAgentPlist(paths);

  assert.match(plist, /com\.zane\.stopwatch-monitor/);
  assert.match(plist, /\/usr\/local\/bin\/node/);
  assert.match(plist, /\/opt\/stopwatch-monitor\/bin\/stopwatch-monitor\.js/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /KeepAlive/);
  assert.match(plist, /\/Users\/example\/\.stopwatch-monitor\/stopwatch-monitor\.log/);
  assert.match(plist, /\/Users\/example\/\.stopwatch-monitor\/stopwatch-monitor\.err\.log/);
});

test("CLI module renders default native Doubao ASR environment without leaking a placeholder key", async () => {
  const { buildDefaultEnvFile } = await import("./cli.js");
  const envFile = buildDefaultEnvFile({ apiKey: "" });

  assert.match(envFile, /MONITOR_STT_PROVIDER=doubao-native/);
  assert.match(envFile, /MONITOR_DOUBAO_NATIVE_ASR_MODEL=bigmodel/);
  assert.match(envFile, /MONITOR_DOUBAO_NATIVE_ASR_RESOURCE_ID=volc\.seedasr\.sauc\.duration/);
  assert.match(envFile, /MONITOR_DOUBAO_NATIVE_ASR_CHUNK_INTERVAL_MS=0/);
  assert.match(envFile, /# DOUBAO_ASR_APP_ID=your-app-id/);
  assert.match(envFile, /# DOUBAO_ASR_ACCESS_TOKEN=your-access-token/);
  assert.match(envFile, /MONITOR_STATUS_SLOW_CACHE_MS=5000/);
  assert.match(envFile, /MONITOR_FOCUSED_DICTATION=1/);
  assert.match(envFile, /MONITOR_TTS_PROVIDER=aliyun/);
  assert.match(envFile, /MONITOR_ALIYUN_TTS_MODEL=cosyvoice-v3-flash/);
  assert.match(envFile, /MONITOR_ALIYUN_TTS_VOICE=longwanjun_v3/);
  assert.match(envFile, /MONITOR_ALIYUN_TTS_VOLUME=100/);
  assert.match(envFile, /MONITOR_TTS_GAIN=4\.8/);
  assert.match(envFile, /MONITOR_DEVICE_WAKE_CUE=0/);
  assert.match(envFile, /MONITOR_WAKE_GREETING=我是傻妞，你的智能秘书。/);
  assert.match(envFile, /MONITOR_WAKE_TTS_VOLUME=100/);
  assert.match(envFile, /MONITOR_WAKE_TTS_GAIN=4\.8/);
  assert.match(envFile, /MONITOR_ASSISTANT_MAX_TOKENS=40/);
  assert.match(envFile, /# MONITOR_DOUBAO_TTS_PROTOCOL=speech/);
  assert.match(envFile, /# MONITOR_DOUBAO_TTS_RESOURCE_ID=seed-tts-2\.0/);
  assert.match(envFile, /# DOUBAO_TTS_API_KEY=your-doubao-speech-api-key/);
  assert.match(envFile, /# DOUBAO_TTS_VOICE=zh_female_jiaochuannv_uranus_bigtts/);
  assert.match(envFile, /# MONITOR_DOUBAO_TTS_PROTOCOL=gateway/);
  assert.doesNotMatch(envFile, /DASHSCOPE_API_KEY=sk-/);
  assert.doesNotMatch(envFile, /^DOUBAO_ASR_API_KEY=apikey-/m);
  assert.doesNotMatch(envFile, /^DOUBAO_ASR_ACCESS_TOKEN=/m);
  assert.doesNotMatch(envFile, /^DOUBAO_TTS_API_KEY=/m);
});

test("start command reports an already running monitor instead of importing a second server", async () => {
  const { runCli } = await import("./cli.js");
  const logs = [];
  const code = await runCli(["start"], {
    paths: {
      home: "/Users/example",
      packageRoot: "/opt/stopwatch-monitor",
      nodePath: "/usr/local/bin/node"
    },
    isPortListening: async (port) => port === 8787,
    importServer: async () => {
      throw new Error("should not import server");
    },
    io: {
      log: (message) => logs.push(String(message))
    }
  });

  assert.equal(code, 0);
  assert.match(logs.join("\n"), /already running on port 8787/);
});
