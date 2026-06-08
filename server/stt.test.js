import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTranscribeAudio, resolveSttProvider } from "./stt.js";

test("resolveSttProvider defaults to Aliyun when no OpenAI key exists", () => {
  assert.equal(resolveSttProvider({ OPENAI_API_KEY: "" }), "aliyun");
  assert.equal(resolveSttProvider({ OPENAI_API_KEY: "sk-test" }), "openai");
  assert.equal(resolveSttProvider({ DASHSCOPE_API_KEY: "sk-test" }), "aliyun");
});

test("resolveSttProvider supports Aliyun DashScope aliases", () => {
  assert.equal(resolveSttProvider({ MONITOR_STT_PROVIDER: "aliyun" }), "aliyun");
  assert.equal(resolveSttProvider({ MONITOR_STT_PROVIDER: "dashscope" }), "aliyun");
});

test("local whisper provider is no longer supported", async () => {
  const transcribe = createTranscribeAudio({
    provider: "local-whisper"
  });

  await assert.rejects(
    () => transcribe(Buffer.from([1])),
    /Unsupported STT provider: local-whisper/
  );
});

test("aliyun provider streams audio to DashScope websocket and parses transcript", async () => {
  FakeAliyunWebSocket.instances = [];
  const transcribe = createTranscribeAudio({
    provider: "aliyun",
    aliyunApiKey: "dashscope-test-key",
    aliyunModel: "fun-asr-realtime",
    aliyunUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    aliyunAudioFormat: "wav",
    aliyunChunkSize: 2,
    aliyunChunkIntervalMs: 0,
    createId: () => "task-123",
    WebSocketImpl: FakeAliyunWebSocket,
    sleep: async () => {}
  });

  const text = await transcribe(Buffer.from([1, 2, 3, 4, 5]));

  assert.equal(text, "打开 Codex 并继续当前任务");
  assert.equal(FakeAliyunWebSocket.instances.length, 1);
  const ws = FakeAliyunWebSocket.instances[0];
  assert.equal(ws.url, "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
  assert.equal(ws.options.headers.Authorization, "Bearer dashscope-test-key");
  assert.equal(ws.options.headers["X-DashScope-DataInspection"], "enable");

  const runTask = JSON.parse(ws.sent.find((item) => typeof item === "string" && item.includes("run-task")));
  assert.equal(runTask.header.action, "run-task");
  assert.equal(runTask.header.task_id, "task-123");
  assert.equal(runTask.header.streaming, "duplex");
  assert.equal(runTask.payload.model, "fun-asr-realtime");
  assert.equal(runTask.payload.parameters.format, "wav");
  assert.equal(runTask.payload.parameters.sample_rate, 16000);
  assert.equal("language_hints" in runTask.payload.parameters, false);

  assert.deepEqual(
    ws.sent.filter((item) => Buffer.isBuffer(item)).map((item) => Array.from(item)),
    [[1, 2], [3, 4], [5]]
  );

  const finishTask = JSON.parse(ws.sent.find((item) => typeof item === "string" && item.includes("finish-task")));
  assert.equal(finishTask.header.action, "finish-task");
  assert.equal(finishTask.header.task_id, "task-123");
});

test("aliyun provider supports Qwen3 ASR Flash realtime websocket protocol", async () => {
  FakeQwenWebSocket.instances = [];
  const transcribe = createTranscribeAudio({
    provider: "aliyun",
    aliyunApiKey: "dashscope-test-key",
    aliyunModel: "qwen3-asr-flash-realtime",
    aliyunChunkSize: 2,
    aliyunChunkIntervalMs: 0,
    timeoutMs: 200,
    createId: createSequentialId("event"),
    WebSocketImpl: FakeQwenWebSocket,
    sleep: async () => {}
  });

  const wav = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVE"),
    Buffer.alloc(32),
    Buffer.from([1, 2, 3, 4, 5])
  ]);
  const text = await transcribe(wav, { sampleRate: 16000 });

  assert.equal(text, "继续优化 StopWatch 语音输入");
  assert.equal(FakeQwenWebSocket.instances.length, 1);
  const ws = FakeQwenWebSocket.instances[0];
  assert.equal(ws.url, "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime");
  assert.equal(ws.options.headers.Authorization, "Bearer dashscope-test-key");
  assert.equal(ws.options.headers["OpenAI-Beta"], "realtime=v1");

  const sessionUpdate = JSON.parse(ws.sent[0]);
  assert.equal(sessionUpdate.type, "session.update");
  assert.equal(sessionUpdate.session.input_audio_format, "pcm");
  assert.equal(sessionUpdate.session.sample_rate, 16000);
  assert.equal(sessionUpdate.session.input_audio_transcription.language, "zh");
  assert.equal(sessionUpdate.session.turn_detection, null);

  const audioEvents = ws.sent.map((item) => JSON.parse(item)).filter((item) => item.type === "input_audio_buffer.append");
  assert.deepEqual(audioEvents.map((item) => Buffer.from(item.audio, "base64")), [
    Buffer.from([1, 2]),
    Buffer.from([3, 4]),
    Buffer.from([5])
  ]);
  assert.equal(ws.sent.some((item) => JSON.parse(item).type === "input_audio_buffer.commit"), true);
  assert.equal(ws.sent.some((item) => JSON.parse(item).type === "session.finish"), true);
});

test("aliyun provider falls back from Qwen3 ASR Flash to Fun-ASR realtime when Qwen route fails", async () => {
  FakeAliyunRouteWebSocket.instances = [];
  const transcribe = createTranscribeAudio({
    provider: "aliyun",
    aliyunApiKey: "dashscope-test-key",
    aliyunModel: "qwen3-asr-flash-realtime",
    aliyunFallbackModel: "fun-asr-realtime",
    aliyunChunkSize: 2,
    aliyunChunkIntervalMs: 0,
    timeoutMs: 200,
    createId: createSequentialId("route"),
    WebSocketImpl: FakeAliyunRouteWebSocket,
    sleep: async () => {}
  });

  const text = await transcribe(Buffer.from([1, 2, 3, 4]));

  assert.equal(text, "这是 Fun-ASR 兜底结果");
  assert.equal(FakeAliyunRouteWebSocket.instances.length, 2);
  assert.match(FakeAliyunRouteWebSocket.instances[0].url, /api-ws\/v1\/realtime\?model=qwen3-asr-flash-realtime$/);
  assert.equal(FakeAliyunRouteWebSocket.instances[0].options.headers["OpenAI-Beta"], "realtime=v1");
  assert.equal(FakeAliyunRouteWebSocket.instances[1].url, "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
  const runTask = JSON.parse(FakeAliyunRouteWebSocket.instances[1].sent.find((item) => item.includes("run-task")));
  assert.equal(runTask.payload.model, "fun-asr-realtime");
});

test("aliyun provider requires a DashScope API key", async () => {
  const transcribe = createTranscribeAudio({
    provider: "aliyun",
    aliyunApiKey: "",
    WebSocketImpl: FakeAliyunWebSocket
  });

  await assert.rejects(
    () => transcribe(Buffer.from([1])),
    /DASHSCOPE_API_KEY is required/
  );
});

class FakeAliyunWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeAliyunWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(data);
    if (typeof data !== "string") return;

    const message = JSON.parse(data);
    if (message.header?.action === "run-task") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          header: { event: "task-started", task_id: message.header.task_id }
        }));
      });
      return;
    }

    if (message.header?.action === "finish-task") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          header: { event: "result-generated", task_id: message.header.task_id },
          payload: {
            output: {
              sentence: {
                text: "打开 Codex 并继续当前任务",
                sentence_end: true
              }
            }
          }
        }));
        this.emit("message", JSON.stringify({
          header: { event: "task-finished", task_id: message.header.task_id }
        }));
      });
    }
  }

  close() {
    this.emit("close");
  }
}

class FakeQwenWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeQwenWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(data);
    if (Buffer.isBuffer(data)) return;
    const message = JSON.parse(data);

    if (message.type === "session.finish") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "继续优化 StopWatch 语音输入"
        }));
        this.emit("message", JSON.stringify({ type: "session.finished" }));
      });
    }
  }

  close() {
    this.emit("close");
  }
}

class FakeAliyunRouteWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeAliyunRouteWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(data);
    if (Buffer.isBuffer(data)) return;
    const message = JSON.parse(data);

    if (this.url.includes("/realtime")) {
      if (message.type === "session.finish") {
        queueMicrotask(() => {
          this.emit("message", JSON.stringify({
            type: "error",
            error: {
              code: "MODEL_ROUTE_FAILED",
              message: "Qwen realtime route failed"
            }
          }));
        });
      }
      return;
    }

    if (message.header?.action === "run-task") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          header: { event: "task-started", task_id: message.header.task_id }
        }));
      });
      return;
    }

    if (message.header?.action === "finish-task") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          header: { event: "result-generated", task_id: message.header.task_id },
          payload: {
            output: {
              sentence: {
                text: "这是 Fun-ASR 兜底结果",
                sentence_end: true
              }
            }
          }
        }));
        this.emit("message", JSON.stringify({
          header: { event: "task-finished", task_id: message.header.task_id }
        }));
      });
    }
  }

  close() {
    this.emit("close");
  }
}

function createSequentialId(prefix) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}
