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

test("CLI module renders default Aliyun Qwen3 environment without leaking a placeholder key", async () => {
  const { buildDefaultEnvFile } = await import("./cli.js");
  const envFile = buildDefaultEnvFile({ apiKey: "" });

  assert.match(envFile, /MONITOR_STT_PROVIDER=aliyun/);
  assert.match(envFile, /MONITOR_ALIYUN_ASR_MODEL=qwen3-asr-flash-realtime/);
  assert.match(envFile, /MONITOR_ALIYUN_FALLBACK_MODEL=fun-asr-realtime/);
  assert.doesNotMatch(envFile, /DASHSCOPE_API_KEY=sk-/);
});
