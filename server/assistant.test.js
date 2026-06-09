import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantMessages, createAssistantResponder, fallbackAssistantReply } from "./assistant.js";

test("assistant replies locally for prepared developer commands", async () => {
  const responder = createAssistantResponder({ apiKey: "" });
  const reply = await responder({
    text: "我要开发一个贪吃蛇小游戏",
    agent: "codex",
    preparedForAgent: true,
    intent: { action: "develop" }
  });

  assert.equal(reply.text, "已准备交给 Codex，按右键发送。");
  assert.equal(reply.source, "local");
});

test("assistant calls Doubao-compatible chat API for conversation turns", async () => {
  const calls = [];
  const responder = createAssistantResponder({
    provider: "doubao",
    apiKey: "ark-test-key",
    model: "doubao-test-model",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "当然，我在。" } }] };
        }
      };
    }
  });

  const reply = await responder({
    text: "你在吗",
    agent: "codex",
    preparedForAgent: false,
    intent: { action: "unknown" }
  });

  assert.equal(reply.text, "当然，我在。");
  assert.equal(reply.source, "doubao");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer ark-test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "doubao-test-model");
  assert.equal(body.messages.at(-1).role, "user");
  assert.match(body.messages.at(-1).content, /你在吗/);
});

test("assistant calls Aliyun OpenAI-compatible chat API for conversation turns", async () => {
  const calls = [];
  const responder = createAssistantResponder({
    provider: "aliyun",
    apiKey: "dashscope-test-key",
    model: "qwen-plus",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "我在，继续说。" } }] };
        }
      };
    }
  });

  const reply = await responder({
    text: "你在吗",
    agent: "codex",
    preparedForAgent: false,
    intent: { action: "unknown" }
  });

  assert.equal(reply.text, "我在，继续说。");
  assert.equal(reply.source, "aliyun");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer dashscope-test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "qwen-plus");
  assert.equal(body.max_tokens, 80);
  assert.equal(body.messages.at(-1).role, "user");
  assert.match(body.messages.at(-1).content, /你在吗/);
});

test("assistant can use a tighter token budget for faster voice replies", async () => {
  const calls = [];
  const responder = createAssistantResponder({
    provider: "aliyun",
    apiKey: "dashscope-test-key",
    model: "qwen-plus",
    maxTokens: 48,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "可以，我会更快回复。" } }] };
        }
      };
    }
  });

  await responder({
    text: "快一点",
    agent: "codex",
    preparedForAgent: false,
    intent: { action: "unknown" }
  });

  assert.equal(JSON.parse(calls[0].init.body).max_tokens, 48);
});

test("assistant includes recent conversation history for continuous dialogue", () => {
  const messages = buildAssistantMessages({
    text: "那我刚才说的是什么",
    agent: "codex",
    preparedForAgent: false,
    intent: { action: "unknown" },
    history: [
      { role: "user", text: "你能做什么" },
      { role: "assistant", text: "我能帮你语音输入和整理任务。" },
      { role: "user", text: "帮我记下来" }
    ]
  });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /连续语音对话/);
  assert.match(messages[0].content, /最多 28 个汉字/);
  assert.deepEqual(messages.slice(1).map((message) => message.role), ["user", "assistant", "user", "user"]);
  assert.equal(messages[1].content, "你能做什么");
  assert.equal(messages[2].content, "我能帮你语音输入和整理任务。");
  assert.equal(messages[3].content, "帮我记下来");
  assert.match(messages[4].content, /那我刚才说的是什么/);
});

test("assistant does not duplicate the current user turn when history already contains it", () => {
  const messages = buildAssistantMessages({
    text: "蓝色",
    agent: "codex",
    preparedForAgent: false,
    intent: { action: "unknown" },
    history: [
      { role: "assistant", text: "你想要什么颜色？" },
      { role: "user", text: "蓝色" }
    ]
  });

  assert.deepEqual(messages.slice(1).map((message) => message.role), ["assistant", "user"]);
  assert.equal(messages[1].content, "你想要什么颜色？");
  assert.match(messages[2].content, /蓝色/);
  assert.equal(messages.filter((message) => message.role === "user" && message.content === "蓝色").length, 0);
});

test("assistant falls back to local reply when chat API fails", async () => {
  const responder = createAssistantResponder({
    apiKey: "ark-test-key",
    fetchImpl: async () => ({ ok: false, text: async () => "bad gateway" })
  });

  const reply = await responder({
    text: "你好",
    agent: "codex",
    preparedForAgent: false,
    intent: { action: "unknown" }
  });

  assert.equal(reply.text, fallbackAssistantReply({ text: "你好", preparedForAgent: false }).text);
  assert.equal(reply.source, "local");
  assert.match(reply.error, /assistant_chat_failed_502/);
});
