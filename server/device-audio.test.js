import assert from "node:assert/strict";
import test from "node:test";
import { applyPcm16Gain, sendPcmSpeechToDevices } from "./device-audio.js";

test("sendPcmSpeechToDevices sends start, base64 chunks, and done to device clients", () => {
  const device = fakeClient("device");
  const browser = fakeClient("client");
  const count = sendPcmSpeechToDevices(new Set([device, browser]), {
    audio: Buffer.from([1, 2, 3, 4, 5]),
    sampleRate: 16000,
    format: "pcm_s16le",
    text: "你好"
  }, { chunkBytes: 2 });

  assert.equal(count, 1);
  assert.equal(browser.sent.length, 0);
  assert.equal(device.sent.length, 5);
  assert.deepEqual(JSON.parse(device.sent[0]), {
    type: "tts_start",
    sampleRate: 16000,
    format: "pcm_s16le",
    text: "你好"
  });
  assert.deepEqual(JSON.parse(device.sent[1]), {
    type: "tts_audio",
    audio: Buffer.from([1, 2]).toString("base64")
  });
  assert.deepEqual(JSON.parse(device.sent[3]), {
    type: "tts_audio",
    audio: Buffer.from([5]).toString("base64")
  });
  assert.deepEqual(JSON.parse(device.sent[4]), { type: "tts_done" });
});

test("sendPcmSpeechToDevices applies pcm gain before chunking audio", () => {
  const device = fakeClient("device");
  const audio = Buffer.alloc(6);
  audio.writeInt16LE(1000, 0);
  audio.writeInt16LE(-2000, 2);
  audio.writeInt16LE(30000, 4);

  const count = sendPcmSpeechToDevices(new Set([device]), {
    audio,
    sampleRate: 16000,
    format: "pcm_s16le",
    text: "你好"
  }, {
    chunkBytes: 6,
    gain: 2
  });

  assert.equal(count, 1);
  const boosted = Buffer.from(JSON.parse(device.sent[1]).audio, "base64");
  assert.equal(Math.abs(boosted.readInt16LE(4)) > 28000, true);
  assert.equal(Math.abs(boosted.readInt16LE(4)) <= 31500, true);
  assert.equal(Math.abs(boosted.readInt16LE(0)) < Math.abs(boosted.readInt16LE(2)), true);
  assert.equal(Math.abs(boosted.readInt16LE(2)) < Math.abs(boosted.readInt16LE(4)), true);
});

test("applyPcm16Gain uses a limiter instead of hard clipping loud speech", () => {
  const audio = Buffer.alloc(6);
  audio.writeInt16LE(2000, 0);
  audio.writeInt16LE(-12000, 2);
  audio.writeInt16LE(30000, 4);

  const boosted = applyPcm16Gain(audio, 3);

  assert.equal(Math.abs(boosted.readInt16LE(4)) > 28000, true);
  assert.equal(Math.abs(boosted.readInt16LE(4)) <= 31500, true);
  assert.notEqual(boosted.readInt16LE(4), 32767);
});

test("sendPcmSpeechToDevices includes after-listen metadata for continuous conversation", () => {
  const device = fakeClient("device");
  sendPcmSpeechToDevices(new Set([device]), {
    audio: Buffer.from([1, 2]),
    sampleRate: 16000,
    format: "pcm_s16le",
    text: "我是傻妞，你的超级秘书。"
  }, {
    after: "listen",
    agent: "claude"
  });

  assert.deepEqual(JSON.parse(device.sent[0]), {
    type: "tts_start",
    sampleRate: 16000,
    format: "pcm_s16le",
    text: "我是傻妞，你的超级秘书。",
    after: "listen",
    agent: "claude"
  });
});

test("applyPcm16Gain leaves non-pcm formats unchanged through caller choice", () => {
  const audio = Buffer.alloc(4);
  audio.writeInt16LE(12000, 0);
  audio.writeInt16LE(-12000, 2);

  const boosted = applyPcm16Gain(audio, 2);

  assert.equal(boosted.readInt16LE(0), 24000);
  assert.equal(boosted.readInt16LE(2), -24000);
});

function fakeClient(role) {
  return {
    role,
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(data);
    }
  };
}
