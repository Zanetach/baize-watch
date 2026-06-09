import assert from "node:assert/strict";
import test from "node:test";
import { interpretVoiceCommand, normalizeVoiceCommand } from "./voice-intent.js";

test("voice intent corrects ASR developer-action confusion in Codex commands", () => {
  const intent = interpretVoiceCommand("我要打那个贪吃蛇的小游戏。");

  assert.equal(intent.raw, "我要打那个贪吃蛇的小游戏。");
  assert.equal(intent.normalized, "我要开发那个贪吃蛇的小游戏。");
  assert.equal(intent.action, "develop");
  assert.equal(intent.needsConfirm, false);
  assert.equal(intent.corrections[0].type, "developer_action_confusion");
});

test("voice intent corrects development homophones before software objects", () => {
  assert.equal(
    normalizeVoiceCommand("帮我开花一个登录页面"),
    "帮我开发一个登录页面"
  );
});

test("voice intent keeps open and real-world action commands unchanged", () => {
  assert.equal(
    normalizeVoiceCommand("我要打开一个页面"),
    "我要打开一个页面"
  );
  assert.equal(
    normalizeVoiceCommand("我要打电话给他"),
    "我要打电话给他"
  );
  assert.equal(
    normalizeVoiceCommand("我要打游戏"),
    "我要打游戏"
  );
});

test("voice intent classifies common command actions without rewriting them", () => {
  assert.equal(interpretVoiceCommand("打开 Codex").action, "open");
  assert.equal(interpretVoiceCommand("发送这句话").action, "send");
  assert.equal(interpretVoiceCommand("总结一下当前任务").action, "ask");
});

test("voice intent routes explicit dictation to Codex or Claude Code", () => {
  const codex = interpretVoiceCommand("发给 Codex 帮我开发一个贪吃蛇小游戏", { agent: "claude" });
  assert.equal(codex.action, "agent");
  assert.equal(codex.targetAgent, "codex");
  assert.equal(codex.normalized, "帮我开发一个贪吃蛇小游戏");

  const claude = interpretVoiceCommand("输入到 Claude Code 检查一下测试失败原因", { agent: "codex" });
  assert.equal(claude.action, "agent");
  assert.equal(claude.targetAgent, "claude");
  assert.equal(claude.normalized, "检查一下测试失败原因");
});

test("voice intent routes dictation to common chat apps and current chat", () => {
  const wechat = interpretVoiceCommand("发给微信 晚上八点开会");
  assert.equal(wechat.action, "dictate");
  assert.equal(wechat.targetApp, "wechat");
  assert.equal(wechat.normalized, "晚上八点开会");

  const feishu = interpretVoiceCommand("输入到飞书 帮我看一下这个方案");
  assert.equal(feishu.action, "dictate");
  assert.equal(feishu.targetApp, "feishu");
  assert.equal(feishu.normalized, "帮我看一下这个方案");

  const current = interpretVoiceCommand("发到当前聊天 我马上到");
  assert.equal(current.action, "dictate");
  assert.equal(current.targetApp, "current");
  assert.equal(current.normalized, "我马上到");
});

test("voice intent can exit continuous conversation mode", () => {
  for (const phrase of ["退出", "退出对话", "结束", "不聊了", "再见", "退下", "退下吧", "你给我退出，退出对话"]) {
    const intent = interpretVoiceCommand(phrase);

    assert.equal(intent.action, "exit_conversation", phrase);
    assert.equal(intent.normalized, phrase);
  }
});

test("voice intent corrects short exit homophones from ASR", () => {
  for (const phrase of ["等一下", "等下", "等一吓"]) {
    const intent = interpretVoiceCommand(phrase);

    assert.equal(intent.raw, phrase);
    assert.equal(intent.normalized, "退下");
    assert.equal(intent.action, "exit_conversation");
    assert.equal(intent.corrections[0].type, "exit_homophone");
  }

  assert.notEqual(interpretVoiceCommand("等一下我看看").action, "exit_conversation");
});

test("voice intent corrects short assistant capability question homophone", () => {
  const intent = interpretVoiceCommand("为什么");

  assert.equal(intent.raw, "为什么");
  assert.equal(intent.normalized, "你会什么");
  assert.equal(intent.action, "ask");
  assert.equal(intent.corrections[0].type, "assistant_question_homophone");
});
