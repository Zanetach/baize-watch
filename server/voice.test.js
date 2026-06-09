import assert from "node:assert/strict";
import test from "node:test";
import { applyPcm16Gain, createVoiceController, makeWavBuffer, normalizeTranscript } from "./voice.js";

test("makeWavBuffer wraps PCM16 audio in a mono 16 kHz WAV container", () => {
  const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f]);
  const wav = makeWavBuffer(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });

  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("applyPcm16Gain amplifies PCM16 samples with a limiter instead of clipping", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-1000, 2);
  pcm.writeInt16LE(30000, 4);
  pcm.writeInt16LE(-30000, 6);

  const boosted = applyPcm16Gain(pcm, 2);

  assert.equal(Math.abs(boosted.readInt16LE(4)) <= 28000, true);
  assert.equal(Math.abs(boosted.readInt16LE(6)) <= 28000, true);
  assert.notEqual(boosted.readInt16LE(4), 32767);
  assert.notEqual(boosted.readInt16LE(6), -32768);
  assert.equal(Math.abs(boosted.readInt16LE(0)) < Math.abs(boosted.readInt16LE(4)), true);
  assert.deepEqual(pcm.subarray(0, 4), Buffer.from([0xe8, 0x03, 0x18, 0xfc]));
});

test("voice controller applies configured gain before transcribing", async () => {
  let wavData = null;
  const pcm = Buffer.alloc(2);
  pcm.writeInt16LE(1200, 0);
  const controller = createVoiceController({
    config: { gain: 2, minRecordingMs: 0 },
    transcribeAudio: async (audio) => {
      wavData = audio.subarray(44);
      return "继续";
    },
    pasteText: async () => {},
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(pcm);
  await controller.stop();

  assert.equal(wavData.readInt16LE(0), 2400);
});

test("voice controller exposes the WAV buffer before transcription for diagnostics", async () => {
  let observed = null;
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    onTranscribeAudio: async (audio, metadata) => {
      observed = { audio, metadata };
    },
    transcribeAudio: async () => "继续",
    pasteText: async () => {},
    pressReturn: async () => {}
  });

  controller.start({ agent: "claude" });
  controller.appendAudio(Buffer.from([1, 0]));
  await controller.stop();

  assert.equal(observed.audio.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(observed.metadata.agent, "claude");
  assert.equal(observed.metadata.sampleRate, 16000);
}
);

test("voice controller rejects recordings that are too short to transcribe accurately", async () => {
  let now = 1000;
  let transcribed = false;
  const controller = createVoiceController({
    now: () => now,
    config: { minRecordingMs: 900 },
    transcribeAudio: async () => {
      transcribed = true;
      return "不应该识别";
    },
    pasteText: async () => {},
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.alloc(1600, 1));
  now += 480;
  const result = await controller.stop();

  assert.equal(result.state, "too_short");
  assert.equal(result.error, "recording_too_short_480ms");
  assert.equal(transcribed, false);
});

test("voice controller reports PCM diagnostics for recorded audio", async () => {
  let now = 2000;
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(1000, 2);
  pcm.writeInt16LE(-2000, 4);
  pcm.writeInt16LE(32767, 6);
  const controller = createVoiceController({
    now: () => now,
    config: { minRecordingMs: 1 },
    transcribeAudio: async () => "继续",
    pasteText: async () => {},
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(pcm);
  now += 1000;
  const result = await controller.stop();

  assert.equal(result.audio.durationMs, 1000);
  assert.equal(result.audio.bytes, 8);
  assert.equal(result.audio.samples, 4);
  assert.equal(result.audio.peak, 32767);
  assert.equal(result.audio.clippedSamples, 1);
  assert.equal(result.audio.rms > 0, true);
});

test("voice controller reports ASR latency in milliseconds", async () => {
  let now = 5000;
  const controller = createVoiceController({
    now: () => now,
    config: { minRecordingMs: 0 },
    transcribeAudio: async () => {
      now += 1480;
      return "继续";
    },
    pasteText: async () => {},
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.asr.latencyMs, 1480);
  assert.equal(result.asr.elapsedMs, 1480);
});

test("normalizeTranscript corrects developer-intent ASR confusion for game-building commands", () => {
  assert.equal(
    normalizeTranscript("我要打那个贪吃蛇的小游戏。"),
    "我要开发那个贪吃蛇的小游戏。"
  );
  assert.equal(
    normalizeTranscript("我要打一个待办事项页面"),
    "我要开发一个待办事项页面"
  );
  assert.equal(
    normalizeTranscript("我要打电话给他"),
    "我要打电话给他"
  );
  assert.equal(
    normalizeTranscript("我要打开一个页面"),
    "我要打开一个页面"
  );
});

test("voice controller records interpreted command metadata", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    transcribeAudio: async () => "我要打一个待办事项页面",
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.text, "我要开发一个待办事项页面");
  assert.equal(result.intent.raw, "我要打一个待办事项页面");
  assert.equal(result.intent.normalized, "我要开发一个待办事项页面");
  assert.equal(result.intent.action, "develop");
  assert.deepEqual(calls, [["paste", "我要开发一个待办事项页面"]]);
});

test("voice controller can keep conversational turns out of the active agent input", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    shouldPasteTranscript: ({ intent }) => intent.action === "develop",
    transcribeAudio: async () => "你在吗",
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.state, "idle");
  assert.equal(result.text, "你在吗");
  assert.equal(result.intent.action, "unknown");
  assert.deepEqual(calls, []);
});

test("voice controller awaits async paste decisions before preparing text", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    shouldPasteTranscript: async () => false,
    transcribeAudio: async () => "我马上到",
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.state, "idle");
  assert.equal(result.preparedForAgent, false);
  assert.deepEqual(calls, []);
});

test("voice controller still prepares developer commands for the active agent", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    shouldPasteTranscript: ({ intent }) => intent.action === "develop",
    transcribeAudio: async () => "我要打一个贪吃蛇小游戏",
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "claude" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.state, "ready");
  assert.equal(result.agent, "claude");
  assert.equal(result.text, "我要开发一个贪吃蛇小游戏");
  assert.deepEqual(calls, [["paste", "我要开发一个贪吃蛇小游戏"]]);
});

test("voice controller routes explicit Codex or Claude dictation to the requested agent", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    shouldPasteTranscript: ({ intent }) => intent.action === "agent",
    transcribeAudio: async () => "发给 Claude Code 检查一下测试失败原因",
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.state, "ready");
  assert.equal(result.agent, "claude");
  assert.equal(result.intent.targetAgent, "claude");
  assert.equal(result.text, "检查一下测试失败原因");
  assert.deepEqual(calls, [["paste", "检查一下测试失败原因"]]);
});

test("voice controller passes app target metadata when dictating into chat apps", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    shouldPasteTranscript: ({ intent }) => intent.action === "dictate",
    transcribeAudio: async () => "发给微信 晚上八点开会",
    pasteText: async (text, context) => calls.push(["paste", text, context.intent.targetApp]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.state, "ready");
  assert.equal(result.text, "晚上八点开会");
  assert.equal(result.intent.action, "dictate");
  assert.equal(result.intent.targetApp, "wechat");
  assert.deepEqual(calls, [["paste", "晚上八点开会", "wechat"]]);
});

test("voice controller exits conversation without preparing text for the agent", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    shouldPasteTranscript: ({ intent }) => intent.action === "agent",
    transcribeAudio: async () => "退出对话",
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.state, "idle");
  assert.equal(result.intent.action, "exit_conversation");
  assert.equal(result.preparedForAgent, false);
  assert.deepEqual(calls, []);
});

test("voice controller treats misrecognized short exit phrase as退下", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    shouldPasteTranscript: ({ intent }) => intent.action === "agent",
    transcribeAudio: async () => "等一下",
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  const result = await controller.stop();

  assert.equal(result.state, "idle");
  assert.equal(result.text, "退下");
  assert.equal(result.intent.raw, "等一下");
  assert.equal(result.intent.action, "exit_conversation");
  assert.equal(result.preparedForAgent, false);
  assert.deepEqual(calls, []);
});

test("voice controller records, transcribes, pastes, then sends on command", async () => {
  const calls = [];
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    transcribeAudio: async (audio, meta) => {
      calls.push(["transcribe", audio.length, meta.agent]);
      return "请帮我总结当前任务";
    },
    pasteText: async (text) => calls.push(["paste", text]),
    pressReturn: async () => calls.push(["send"])
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2]));
  controller.appendAudio(Buffer.from([3, 4]));
  const result = await controller.stop();

  assert.equal(result.text, "请帮我总结当前任务");
  assert.equal(controller.status().state, "ready");
  assert.deepEqual(calls, [
    ["transcribe", 48, "codex"],
    ["paste", "请帮我总结当前任务"]
  ]);

  await controller.send();

  assert.equal(controller.status().state, "idle");
  assert.deepEqual(calls.at(-1), ["send"]);
});

test("voice controller can prepare exported conversation text for focused send", async () => {
  const calls = [];
  const controller = createVoiceController({
    pasteText: async (text, context) => calls.push(["paste", text, context.intent.action]),
    pressReturn: async () => calls.push(["send"]),
    transcribeAudio: async () => ""
  });

  const result = await controller.prepareText("我：你能做什么\n傻妞：我能帮你整理任务。", {
    agent: "codex",
    intent: { action: "conversation_export" }
  });

  assert.equal(result.state, "ready");
  assert.equal(result.text, "我：你能做什么\n傻妞：我能帮你整理任务。");
  assert.deepEqual(calls, [["paste", "我：你能做什么\n傻妞：我能帮你整理任务。", "conversation_export"]]);

  await controller.send();

  assert.deepEqual(calls.at(-1), ["send"]);
});

test("voice controller can cancel an active recording without transcribing", async () => {
  let transcribed = false;
  const controller = createVoiceController({
    config: { minRecordingMs: 0 },
    transcribeAudio: async () => {
      transcribed = true;
      return "不应该识别";
    },
    pasteText: async () => {},
    pressReturn: async () => {}
  });

  controller.start({ agent: "codex" });
  controller.appendAudio(Buffer.from([1, 2, 3, 4]));
  const result = controller.cancel();

  assert.equal(result.state, "idle");
  assert.equal(result.bytes, 0);
  assert.equal(result.text, "");
  assert.equal(transcribed, false);
});

test("voice controller reports empty recordings without transcribing", async () => {
  const controller = createVoiceController({
    transcribeAudio: async () => {
      throw new Error("should not transcribe empty audio");
    },
    pasteText: async () => {
      throw new Error("should not paste empty audio");
    },
    pressReturn: async () => {}
  });

  controller.start({ agent: "claude" });
  const result = await controller.stop();

  assert.equal(result.state, "empty");
  assert.equal(controller.status().state, "idle");
});
