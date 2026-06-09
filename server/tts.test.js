import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createAliyunTtsSynthesizer,
  createCachedSpeechSynthesizer,
  createDoubaoTtsSynthesizer
} from "./tts.js";

test("doubao tts synthesizer streams text and returns pcm audio", async () => {
  FakeTtsWebSocket.instances = [];
  const synthesize = createDoubaoTtsSynthesizer({
    apiKey: "tts-test-key",
    protocol: "gateway",
    model: "doubao-tts",
    voice: "zh_female_kailangjiejie_moon_bigtts",
    sampleRate: 16000,
    createId: createSequentialId("tts"),
    WebSocketImpl: FakeTtsWebSocket
  });

  const result = await synthesize("你好，我在。");

  assert.equal(result.format, "pcm_s16le");
  assert.equal(result.sampleRate, 16000);
  assert.deepEqual(result.audio, Buffer.from([1, 2, 3, 4]));
  assert.equal(FakeTtsWebSocket.instances.length, 1);
  const ws = FakeTtsWebSocket.instances[0];
  assert.equal(ws.url, "wss://ai-gateway.vei.volces.com/v1/realtime?model=doubao-tts");
  assert.equal(ws.options.headers.Authorization, "Bearer tts-test-key");
  const session = JSON.parse(ws.sent[0]);
  assert.equal(session.type, "tts_session.update");
  assert.equal(session.session.voice, "zh_female_kailangjiejie_moon_bigtts");
  assert.equal(session.session.output_audio_format, "pcm");
  assert.equal(session.session.output_audio_sample_rate, 16000);
  assert.equal(JSON.parse(ws.sent[1]).type, "input_text.append");
  assert.equal(JSON.parse(ws.sent[1]).delta, "你好，我在。");
  assert.equal(JSON.parse(ws.sent[2]).type, "input_text.done");
});

test("doubao tts synthesizer uses official speech api for uuid api keys", async () => {
  const calls = [];
  const synthesize = createDoubaoTtsSynthesizer({
    apiKey: "00000000-0000-4000-8000-000000000001",
    resourceId: "seed-tts-2.0",
    voice: "zh_female_jiaochuannv_uranus_bigtts",
    sampleRate: 16000,
    createId: createSequentialId("speech-tts"),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async text() {
          return [
            "event: 352",
            `data: ${JSON.stringify({ audio: Buffer.from([1, 2]).toString("base64") })}`,
            "",
            "event: 352",
            `data: ${JSON.stringify({ data: { audio: Buffer.from([3, 4]).toString("base64") } })}`,
            "",
            "event: 152",
            `data: ${JSON.stringify({ code: 20000000, message: "ok" })}`,
            ""
          ].join("\n");
        }
      };
    }
  });

  const result = await synthesize("你好，我是傻妞。");

  assert.equal(result.format, "pcm_s16le");
  assert.equal(result.sampleRate, 16000);
  assert.deepEqual(result.audio, Buffer.from([1, 2, 3, 4]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse");
  assert.equal(calls[0].init.headers["X-Api-Key"], "00000000-0000-4000-8000-000000000001");
  assert.equal(calls[0].init.headers["X-Api-Resource-Id"], "seed-tts-2.0");
  assert.equal(calls[0].init.headers["X-Api-Request-Id"], "speech-tts-1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.user.uid, "stopwatch-monitor");
  assert.deepEqual(body.req_params, {
    text: "你好，我是傻妞。",
    speaker: "zh_female_jiaochuannv_uranus_bigtts",
    audio_params: {
      format: "pcm",
      sample_rate: 16000
    }
  });
});

test("doubao speech tts reports resource grant errors", async () => {
  const synthesize = createDoubaoTtsSynthesizer({
    apiKey: "00000000-0000-4000-8000-000000000001",
    resourceId: "seed-tts-2.0",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return [
          "event: 153",
          `data: ${JSON.stringify({ code: 45000030, message: "[resource_id=volc.seedtts.default] requested resource not granted" })}`,
          ""
        ].join("\n");
      }
    })
  });

  await assert.rejects(
    () => synthesize("你好"),
    /requested resource not granted/
  );
});

test("doubao tts synthesizer requires an api key", async () => {
  const synthesize = createDoubaoTtsSynthesizer({ apiKey: "" });

  await assert.rejects(
    () => synthesize("你好"),
    /DOUBAO_TTS_API_KEY is required/
  );
});

test("aliyun tts synthesizer streams text and returns pcm audio", async () => {
  const calls = [];
  const synthesize = createAliyunTtsSynthesizer({
    apiKey: "dashscope-test-key",
    model: "cosyvoice-v3-flash",
    voice: "longwanjun_v3",
    sampleRate: 16000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async text() {
          return [
            "event: result",
            `data: ${JSON.stringify({ output: { type: "sentence-synthesis", audio: { data: Buffer.from([1, 2]).toString("base64") } } })}`,
            "",
            `data: ${JSON.stringify({ output: { type: "sentence-synthesis", audio: { data: Buffer.from([3, 4]).toString("base64") } } })}`,
            "",
            "data: [DONE]",
            ""
          ].join("\n");
        }
      };
    }
  });

  const result = await synthesize("你好，我在。");

  assert.equal(result.format, "pcm_s16le");
  assert.equal(result.sampleRate, 16000);
  assert.deepEqual(result.audio, Buffer.from([1, 2, 3, 4]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
  assert.equal(calls[0].init.headers.authorization, "Bearer dashscope-test-key");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers["X-DashScope-SSE"], "enable");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "cosyvoice-v3-flash");
  assert.deepEqual(body.input, {
    text: "你好，我在。",
    voice: "longwanjun_v3",
    format: "pcm",
    sample_rate: 16000,
    volume: 80
  });
});

test("aliyun tts synthesizer can override volume for wake speech", async () => {
  const calls = [];
  const synthesize = createAliyunTtsSynthesizer({
    apiKey: "dashscope-test-key",
    volume: 80,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async text() {
          return [
            `data: ${JSON.stringify({ output: { audio: { data: Buffer.from([1, 2]).toString("base64") } } })}`,
            "",
            "data: [DONE]",
            ""
          ].join("\n");
        }
      };
    }
  });

  await synthesize("我是傻妞。你的超级秘书。", { volume: 100 });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.input.volume, 100);
});

test("cached speech synthesizer reuses concurrent and repeated wake speech", async () => {
  let calls = 0;
  const synthesize = createCachedSpeechSynthesizer(async (text, options) => {
    calls++;
    return {
      audio: Buffer.from([calls, String(text).length, options.volume || 0]),
      sampleRate: 16000,
      format: "pcm_s16le"
    };
  });

  const [first, second] = await Promise.all([
    synthesize("我是傻妞，你的智能秘书。", { volume: 100, cacheKey: "wake:codex" }),
    synthesize("我是傻妞，你的智能秘书。", { volume: 100, cacheKey: "wake:codex" })
  ]);
  const third = await synthesize("我是傻妞，你的智能秘书。", { volume: 100, cacheKey: "wake:codex" });
  const normal = await synthesize("普通回复", { volume: 100 });

  assert.equal(calls, 2);
  assert.deepEqual(first.audio, Buffer.from([1, 12, 100]));
  assert.deepEqual(second.audio, first.audio);
  assert.deepEqual(third.audio, first.audio);
  assert.notEqual(first.audio, second.audio);
  assert.deepEqual(normal.audio, Buffer.from([2, 4, 100]));
});

test("aliyun tts synthesizer requires a DashScope api key", async () => {
  const synthesize = createAliyunTtsSynthesizer({ apiKey: "" });

  await assert.rejects(
    () => synthesize("你好"),
    /DASHSCOPE_API_KEY is required/
  );
});

class FakeTtsWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeTtsWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(data);
    const message = JSON.parse(data);
    if (message.type === "input_text.done") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "response.audio.delta",
          delta: Buffer.from([1, 2]).toString("base64")
        }));
        this.emit("message", JSON.stringify({
          type: "response.audio.delta",
          delta: Buffer.from([3, 4]).toString("base64")
        }));
        this.emit("message", JSON.stringify({ type: "response.audio.done" }));
      });
    }
  }

  close() {}
}

function createSequentialId(prefix) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}
