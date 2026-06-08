import assert from "node:assert/strict";
import test from "node:test";
import { applyPcm16Gain, createVoiceController, makeWavBuffer } from "./voice.js";

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

test("applyPcm16Gain amplifies PCM16 samples with clipping", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-1000, 2);
  pcm.writeInt16LE(30000, 4);
  pcm.writeInt16LE(-30000, 6);

  const boosted = applyPcm16Gain(pcm, 2);

  assert.equal(boosted.readInt16LE(0), 2000);
  assert.equal(boosted.readInt16LE(2), -2000);
  assert.equal(boosted.readInt16LE(4), 32767);
  assert.equal(boosted.readInt16LE(6), -32768);
  assert.deepEqual(pcm.subarray(0, 4), Buffer.from([0xe8, 0x03, 0x18, 0xfc]));
});

test("voice controller applies configured gain before transcribing", async () => {
  let wavData = null;
  const pcm = Buffer.alloc(2);
  pcm.writeInt16LE(1200, 0);
  const controller = createVoiceController({
    config: { gain: 2 },
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

test("voice controller records, transcribes, pastes, then sends on command", async () => {
  const calls = [];
  const controller = createVoiceController({
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
