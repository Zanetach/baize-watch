import assert from "node:assert/strict";
import test from "node:test";
import {
  activationNameForTargetApp,
  buildPasteScript,
  normalizeTargetApp
} from "./app-targets.js";

test("normalizes common chat app names from voice commands", () => {
  assert.equal(normalizeTargetApp("微信"), "wechat");
  assert.equal(normalizeTargetApp("WeChat"), "wechat");
  assert.equal(normalizeTargetApp("飞书"), "feishu");
  assert.equal(normalizeTargetApp("lark"), "feishu");
  assert.equal(normalizeTargetApp("当前聊天"), "current");
});

test("maps target apps to macOS activation names when safe", () => {
  assert.equal(activationNameForTargetApp("wechat"), "WeChat");
  assert.equal(activationNameForTargetApp("feishu"), "Feishu");
  assert.equal(activationNameForTargetApp("codex"), "Codex");
  assert.equal(activationNameForTargetApp("claude"), "");
  assert.equal(activationNameForTargetApp("current"), "");
});

test("paste script can optionally activate a target app before pasting", () => {
  const script = buildPasteScript();

  assert.match(script.join("\n"), /set targetApp to item 2 of argv/);
  assert.match(script.join("\n"), /tell application targetApp to activate/);
  assert.match(script.join("\n"), /keystroke "v" using command down/);
});
