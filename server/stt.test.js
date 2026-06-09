import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
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

test("resolveSttProvider supports Doubao ASR aliases", () => {
  assert.equal(resolveSttProvider({ MONITOR_STT_PROVIDER: "doubao" }), "doubao");
  assert.equal(resolveSttProvider({ MONITOR_STT_PROVIDER: "volcengine" }), "doubao");
  assert.equal(resolveSttProvider({ MONITOR_STT_PROVIDER: "bytedance" }), "doubao");
  assert.equal(resolveSttProvider({ DOUBAO_ASR_API_KEY: "doubao-test-key" }), "doubao");
});

test("resolveSttProvider supports native Doubao ASR aliases", () => {
  assert.equal(resolveSttProvider({ MONITOR_STT_PROVIDER: "doubao-native" }), "doubao-native");
  assert.equal(resolveSttProvider({ MONITOR_STT_PROVIDER: "volcengine-native" }), "doubao-native");
  assert.equal(resolveSttProvider({ DOUBAO_ASR_APP_ID: "app-id", DOUBAO_ASR_ACCESS_TOKEN: "access-token" }), "doubao-native");
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

test("aliyun provider passes configured hotword vocabulary to inference models", async () => {
  FakeAliyunWebSocket.instances = [];
  const transcribe = createTranscribeAudio({
    provider: "aliyun",
    aliyunApiKey: "dashscope-test-key",
    aliyunModel: "fun-asr-realtime",
    aliyunVocabularyId: "vocab-codex-123",
    aliyunChunkSize: 8,
    aliyunChunkIntervalMs: 0,
    createId: () => "task-hotwords",
    WebSocketImpl: FakeAliyunWebSocket,
    sleep: async () => {}
  });

  await transcribe(Buffer.from([1, 2, 3]));

  const runTask = JSON.parse(FakeAliyunWebSocket.instances[0].sent.find((item) => typeof item === "string" && item.includes("run-task")));
  assert.equal(runTask.payload.parameters.vocabulary_id, "vocab-codex-123");
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

test("aliyun provider retries weak Qwen transcripts with Fun-ASR for longer audio", async () => {
  FakeAliyunWeakQwenWebSocket.instances = [];
  const transcribe = createTranscribeAudio({
    provider: "aliyun",
    aliyunApiKey: "dashscope-test-key",
    aliyunModel: "qwen3-asr-flash-realtime",
    aliyunFallbackModel: "fun-asr-realtime",
    aliyunChunkSize: 64000,
    aliyunChunkIntervalMs: 0,
    timeoutMs: 200,
    createId: createSequentialId("weak"),
    WebSocketImpl: FakeAliyunWeakQwenWebSocket,
    sleep: async () => {}
  });

  const twoSecondWav = makeTestWav(Buffer.alloc(16000 * 2 * 2, 1));
  const text = await transcribe(twoSecondWav, { sampleRate: 16000 });

  assert.equal(text, "打开 Codex 并继续当前任务");
  assert.equal(FakeAliyunWeakQwenWebSocket.instances.length, 2);
  assert.match(FakeAliyunWeakQwenWebSocket.instances[0].url, /api-ws\/v1\/realtime\?model=qwen3-asr-flash-realtime$/);
  assert.equal(FakeAliyunWeakQwenWebSocket.instances[1].url, "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
});

test("doubao provider streams PCM to Volcengine realtime ASR and parses transcript", async () => {
  FakeDoubaoWebSocket.instances = [];
  const transcribe = createTranscribeAudio({
    provider: "doubao",
    doubaoApiKey: "doubao-test-key",
    doubaoModel: "bigmodel",
    doubaoUrl: "wss://ai-gateway.vei.volces.com/v1/realtime",
    doubaoResourceId: "volc.bigasr.sauc.duration",
    doubaoChunkSize: 2,
    doubaoChunkIntervalMs: 0,
    timeoutMs: 200,
    WebSocketImpl: FakeDoubaoWebSocket,
    sleep: async () => {}
  });

  const wav = makeTestWav(Buffer.from([1, 2, 3, 4, 5]));
  const text = await transcribe(wav, { sampleRate: 16000 });

  assert.equal(text, "你会什么");
  assert.equal(FakeDoubaoWebSocket.instances.length, 1);
  const ws = FakeDoubaoWebSocket.instances[0];
  assert.equal(ws.url, "wss://ai-gateway.vei.volces.com/v1/realtime?model=bigmodel");
  assert.equal(ws.options.headers.Authorization, "Bearer doubao-test-key");
  assert.equal(ws.options.headers["X-Api-Resource-Id"], "volc.bigasr.sauc.duration");

  const sessionUpdate = JSON.parse(ws.sent[0]);
  assert.equal(sessionUpdate.type, "transcription_session.update");
  assert.equal(sessionUpdate.session.input_audio_format, "pcm");
  assert.equal(sessionUpdate.session.input_audio_codec, "raw");
  assert.equal(sessionUpdate.session.input_audio_sample_rate, 16000);
  assert.equal(sessionUpdate.session.input_audio_bits, 16);
  assert.equal(sessionUpdate.session.input_audio_channel, 1);
  assert.equal(sessionUpdate.session.input_audio_transcription.model, "bigmodel");

  const audioEvents = ws.sent.map((item) => JSON.parse(item)).filter((item) => item.type === "input_audio_buffer.append");
  assert.deepEqual(audioEvents.map((item) => Buffer.from(item.audio, "base64")), [
    Buffer.from([1, 2]),
    Buffer.from([3, 4]),
    Buffer.from([5])
  ]);
  assert.equal(ws.sent.some((item) => JSON.parse(item).type === "input_audio_buffer.commit"), true);
});

test("doubao provider requires an API key", async () => {
  const transcribe = createTranscribeAudio({
    provider: "doubao",
    doubaoApiKey: "",
    WebSocketImpl: FakeDoubaoWebSocket
  });

  await assert.rejects(
    () => transcribe(Buffer.from([1])),
    /DOUBAO_ASR_API_KEY is required/
  );
});

test("native doubao provider sends Volcengine bigmodel 2.0 frames and parses transcript", async () => {
  FakeDoubaoNativeWebSocket.instances = [];
  const transcribe = createTranscribeAudio({
    provider: "doubao-native",
    doubaoNativeAppKey: "app-id-test",
    doubaoNativeAccessKey: "access-token-test",
    doubaoNativeUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
    doubaoNativeResourceId: "volc.seedasr.sauc.duration",
    doubaoNativeModel: "bigmodel",
    doubaoNativeChunkSize: 100,
    doubaoNativeChunkIntervalMs: 0,
    timeoutMs: 200,
    createId: () => "native-connect-id",
    WebSocketImpl: FakeDoubaoNativeWebSocket,
    sleep: async () => {}
  });

  const text = await transcribe(makeTestWav(Buffer.from([1, 2, 3, 4, 5])), { sampleRate: 16000 });

  assert.equal(text, "你会什么");
  assert.equal(FakeDoubaoNativeWebSocket.instances.length, 1);
  const ws = FakeDoubaoNativeWebSocket.instances[0];
  assert.equal(ws.url, "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream");
  assert.equal(ws.options.headers["X-Api-App-Key"], "app-id-test");
  assert.equal(ws.options.headers["X-Api-Access-Key"], "access-token-test");
  assert.equal(ws.options.headers["X-Api-Resource-Id"], "volc.seedasr.sauc.duration");
  assert.equal(ws.options.headers["X-Api-Connect-Id"], "native-connect-id");

  const initFrame = parseVolcFrame(ws.sent[0]);
  assert.equal(initFrame.messageType, 1);
  assert.equal(initFrame.serialization, 1);
  assert.equal(initFrame.compression, 1);
  assert.equal(initFrame.payload.audio.format, "pcm");
  assert.equal(initFrame.payload.audio.codec, "raw");
  assert.equal(initFrame.payload.audio.rate, 16000);
  assert.equal(initFrame.payload.request.model_name, "bigmodel");
  assert.equal(initFrame.payload.request.enable_itn, true);

  const audioFrame = parseVolcFrame(ws.sent[1]);
  assert.equal(audioFrame.messageType, 2);
  assert.equal(audioFrame.sequence, -2);
  assert.deepEqual(Array.from(audioFrame.payload), [1, 2, 3, 4, 5]);
});

test("native doubao provider requires app id and access token", async () => {
  const transcribe = createTranscribeAudio({
    provider: "doubao-native",
    doubaoNativeAppKey: "",
    doubaoNativeAccessKey: "",
    WebSocketImpl: FakeDoubaoNativeWebSocket
  });

  await assert.rejects(
    () => transcribe(Buffer.from([1])),
    /DOUBAO_ASR_APP_ID and DOUBAO_ASR_ACCESS_TOKEN are required/
  );
});

test("native doubao provider reports server error frames with readable messages", async () => {
  const transcribe = createTranscribeAudio({
    provider: "doubao-native",
    doubaoNativeAppKey: "app-id-test",
    doubaoNativeAccessKey: "access-token-test",
    doubaoNativeResourceId: "volc.seedasr.sauc.duration",
    timeoutMs: 200,
    createId: () => "native-error-id",
    WebSocketImpl: FakeDoubaoNativeErrorWebSocket,
    sleep: async () => {}
  });

  await assert.rejects(
    () => transcribe(makeTestWav(Buffer.from([1, 2, 3])), { sampleRate: 16000 }),
    /doubao_native_transcription_failed_401: invalid access token/
  );
});

test("native doubao provider resolves empty text when server closes after audio without a transcript", async () => {
  const transcribe = createTranscribeAudio({
    provider: "doubao-native",
    doubaoNativeAppKey: "app-id-test",
    doubaoNativeAccessKey: "access-token-test",
    doubaoNativeResourceId: "volc.seedasr.sauc.duration",
    timeoutMs: 200,
    createId: () => "native-empty-id",
    WebSocketImpl: FakeDoubaoNativeEmptyCloseWebSocket,
    sleep: async () => {}
  });

  const text = await transcribe(makeTestWav(Buffer.from([1, 2, 3])), { sampleRate: 16000 });

  assert.equal(text, "");
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

class FakeAliyunWeakQwenWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeAliyunWeakQwenWebSocket.instances.push(this);
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
            type: "conversation.item.input_audio_transcription.completed",
            transcript: "对。"
          }));
          this.emit("message", JSON.stringify({ type: "session.finished" }));
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

class FakeDoubaoWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeDoubaoWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(data);
    const message = JSON.parse(data);

    if (message.type === "transcription_session.update") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "transcription_session.updated",
          session: message.session
        }));
      });
      return;
    }

    if (message.type === "input_audio_buffer.commit") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "conversation.item.input_audio_transcription.result",
          transcript: "你会"
        }));
        this.emit("message", JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "你会什么"
        }));
      });
    }
  }

  close() {
    this.emit("close");
  }
}

class FakeDoubaoNativeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeDoubaoNativeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(data);
    if (!Buffer.isBuffer(data)) return;

    const frame = parseVolcFrame(data);
    if (frame.messageType === 2 && frame.sequence < 0) {
      queueMicrotask(() => {
        this.emit("message", buildVolcResponseFrame({
          result: {
            text: "你会什么"
          }
        }));
      });
    }
  }

  close() {
    this.emit("close");
  }
}

class FakeDoubaoNativeErrorWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    if (!Buffer.isBuffer(data)) return;
    queueMicrotask(() => {
      this.emit("message", buildVolcErrorFrame(401, {
        error: {
          message: "invalid access token"
        }
      }));
    });
  }

  close() {
    this.emit("close");
  }
}

class FakeDoubaoNativeEmptyCloseWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    if (!Buffer.isBuffer(data)) return;
    const frame = parseVolcFrame(data);
    if (frame.messageType === 2 && frame.sequence < 0) {
      queueMicrotask(() => this.emit("close"));
    }
  }

  close() {
    this.emit("close");
  }
}

function parseVolcFrame(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize;
  let sequence = null;
  if (flags === 1 || flags === 2 || flags === 3) {
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  }
  const payloadSize = buffer.readUInt32BE(offset);
  offset += 4;
  let payload = buffer.subarray(offset, offset + payloadSize);
  if (compression === 1) {
    payload = gunzipSync(payload);
  }
  if (serialization === 1) {
    payload = JSON.parse(payload.toString("utf8"));
  }
  return {
    messageType,
    flags,
    serialization,
    compression,
    sequence,
    payload
  };
}

function buildVolcResponseFrame(payload) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    Buffer.from([0x11, 0x90, 0x11, 0x00]),
    size,
    body
  ]);
}

function buildVolcErrorFrame(code, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const codeBuffer = Buffer.alloc(4);
  codeBuffer.writeInt32BE(code, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    Buffer.from([0x11, 0xf0, 0x10, 0x00]),
    codeBuffer,
    size,
    body
  ]);
}

function makeTestWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function createSequentialId(prefix) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}
