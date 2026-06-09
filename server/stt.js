import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { WebSocket as DefaultWebSocket } from "ws";

const defaultSttPrompt = "这是一段普通话中文语音，内容是给 Codex 或 Claude Code 的简短指令。请输出简体中文，保留用户原意，不要翻译，不要添加解释。";
const defaultAliyunInferenceUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const defaultAliyunQwenRealtimeUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const defaultAliyunModel = "fun-asr-realtime";
const defaultAliyunFallbackModel = "fun-asr-realtime";
const defaultDoubaoRealtimeUrl = "wss://ai-gateway.vei.volces.com/v1/realtime";
const defaultDoubaoModel = "bigmodel";
const defaultDoubaoResourceId = "volc.bigasr.sauc.duration";
const defaultDoubaoNativeUrl = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const defaultDoubaoNativeModel = "bigmodel";
const defaultDoubaoNativeResourceId = "volc.seedasr.sauc.duration";

export function resolveSttProvider(env = process.env) {
  const requested = String(env.MONITOR_STT_PROVIDER || "").trim().toLowerCase();
  if (requested) return normalizeProvider(requested);
  if ((env.DOUBAO_ASR_APP_ID || env.DOUBAO_ASR_APP_KEY || env.MONITOR_DOUBAO_ASR_APP_ID) &&
    (env.DOUBAO_ASR_ACCESS_TOKEN || env.DOUBAO_ASR_ACCESS_KEY || env.MONITOR_DOUBAO_ASR_ACCESS_TOKEN)) return "doubao-native";
  if (env.DOUBAO_ASR_API_KEY || env.MONITOR_DOUBAO_ASR_API_KEY || env.VOLCENGINE_ASR_API_KEY || env.AI_GATEWAY_API_KEY) return "doubao";
  return env.OPENAI_API_KEY ? "openai" : "aliyun";
}

export function createTranscribeAudio({
  provider = resolveSttProvider(),
  openaiApiKey = process.env.OPENAI_API_KEY,
  openaiModel = process.env.MONITOR_STT_MODEL || "gpt-4o-mini-transcribe",
  aliyunApiKey = process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_DASHSCOPE_API_KEY || process.env.MONITOR_ALIYUN_API_KEY || process.env.ALIYUN_API_KEY,
  aliyunModel = process.env.MONITOR_ALIYUN_ASR_MODEL || defaultAliyunModel,
  aliyunFallbackModel = process.env.MONITOR_ALIYUN_FALLBACK_MODEL || defaultAliyunFallbackModel,
  aliyunProtocol = process.env.MONITOR_ALIYUN_ASR_PROTOCOL || "auto",
  aliyunUrl = process.env.MONITOR_ALIYUN_ASR_URL || "",
  aliyunAudioFormat = process.env.MONITOR_ALIYUN_AUDIO_FORMAT || "",
  aliyunVocabularyId = process.env.MONITOR_ALIYUN_VOCABULARY_ID || process.env.DASHSCOPE_VOCABULARY_ID || "",
  aliyunLanguageHint = process.env.MONITOR_ALIYUN_LANGUAGE_HINT || "",
  aliyunChunkSize = parsePositiveInt(process.env.MONITOR_ALIYUN_CHUNK_SIZE, 3200),
  aliyunChunkIntervalMs = parseNonNegativeInt(process.env.MONITOR_ALIYUN_CHUNK_INTERVAL_MS, 0),
  doubaoApiKey = process.env.DOUBAO_ASR_API_KEY || process.env.MONITOR_DOUBAO_ASR_API_KEY || process.env.VOLCENGINE_ASR_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY,
  doubaoModel = process.env.MONITOR_DOUBAO_ASR_MODEL || process.env.DOUBAO_ASR_MODEL || defaultDoubaoModel,
  doubaoUrl = process.env.MONITOR_DOUBAO_ASR_URL || process.env.DOUBAO_ASR_URL || defaultDoubaoRealtimeUrl,
  doubaoResourceId = process.env.MONITOR_DOUBAO_ASR_RESOURCE_ID || process.env.DOUBAO_ASR_RESOURCE_ID || defaultDoubaoResourceId,
  doubaoChunkSize = parsePositiveInt(process.env.MONITOR_DOUBAO_ASR_CHUNK_SIZE, 3200),
  doubaoChunkIntervalMs = parseNonNegativeInt(process.env.MONITOR_DOUBAO_ASR_CHUNK_INTERVAL_MS, 0),
  doubaoNativeAppKey = process.env.DOUBAO_ASR_APP_ID || process.env.DOUBAO_ASR_APP_KEY || process.env.MONITOR_DOUBAO_ASR_APP_ID || process.env.MONITOR_DOUBAO_ASR_APP_KEY || "",
  doubaoNativeAccessKey = process.env.DOUBAO_ASR_ACCESS_TOKEN || process.env.DOUBAO_ASR_ACCESS_KEY || process.env.DOUBAO_ASR_TOKEN || process.env.MONITOR_DOUBAO_ASR_ACCESS_TOKEN || process.env.MONITOR_DOUBAO_ASR_ACCESS_KEY || "",
  doubaoNativeUrl = process.env.MONITOR_DOUBAO_NATIVE_ASR_URL || process.env.DOUBAO_NATIVE_ASR_URL || defaultDoubaoNativeUrl,
  doubaoNativeResourceId = process.env.MONITOR_DOUBAO_NATIVE_ASR_RESOURCE_ID || process.env.MONITOR_DOUBAO_ASR_RESOURCE_ID || process.env.DOUBAO_ASR_RESOURCE_ID || defaultDoubaoNativeResourceId,
  doubaoNativeModel = process.env.MONITOR_DOUBAO_NATIVE_ASR_MODEL || process.env.MONITOR_DOUBAO_ASR_MODEL || process.env.DOUBAO_ASR_MODEL || defaultDoubaoNativeModel,
  doubaoNativeChunkSize = parsePositiveInt(process.env.MONITOR_DOUBAO_NATIVE_ASR_CHUNK_SIZE || process.env.MONITOR_DOUBAO_ASR_CHUNK_SIZE, 3200),
  doubaoNativeChunkIntervalMs = parseNonNegativeInt(process.env.MONITOR_DOUBAO_NATIVE_ASR_CHUNK_INTERVAL_MS || process.env.MONITOR_DOUBAO_ASR_CHUNK_INTERVAL_MS, 0),
  language = process.env.MONITOR_STT_LANGUAGE || "zh",
  prompt = process.env.MONITOR_STT_PROMPT || defaultSttPrompt,
  timeoutMs = Number.parseInt(process.env.MONITOR_STT_TIMEOUT_MS || "120000", 10),
  createId = randomUUID,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = DefaultWebSocket,
  sleep = defaultSleep
} = {}) {
  const normalizedProvider = normalizeProvider(provider);

  return async function transcribeAudio(audio, metadata = {}) {
    if (normalizedProvider === "openai") {
      return transcribeWithOpenAI(audio, {
        apiKey: openaiApiKey,
        model: openaiModel,
        language,
        prompt,
        fetchImpl
      });
    }

    if (normalizedProvider === "aliyun") {
      return transcribeWithAliyun(audio, {
        apiKey: aliyunApiKey,
        model: aliyunModel,
        fallbackModel: aliyunFallbackModel,
        protocol: aliyunProtocol,
        url: aliyunUrl,
        audioFormat: aliyunAudioFormat,
        vocabularyId: aliyunVocabularyId,
        language: aliyunLanguageHint || language,
        sampleRate: metadata.sampleRate || 16000,
        chunkSize: aliyunChunkSize,
        chunkIntervalMs: aliyunChunkIntervalMs,
        timeoutMs,
        createId,
        WebSocketImpl,
        sleep
      });
    }

    if (normalizedProvider === "doubao") {
      return transcribeWithDoubao(audio, {
        apiKey: doubaoApiKey,
        model: doubaoModel,
        url: doubaoUrl,
        resourceId: doubaoResourceId,
        sampleRate: metadata.sampleRate || 16000,
        chunkSize: doubaoChunkSize,
        chunkIntervalMs: doubaoChunkIntervalMs,
        timeoutMs,
        WebSocketImpl,
        sleep
      });
    }

    if (normalizedProvider === "doubao-native") {
      return transcribeWithDoubaoNative(audio, {
        appKey: doubaoNativeAppKey,
        accessKey: doubaoNativeAccessKey,
        model: doubaoNativeModel,
        url: doubaoNativeUrl,
        resourceId: doubaoNativeResourceId,
        sampleRate: metadata.sampleRate || 16000,
        chunkSize: doubaoNativeChunkSize,
        chunkIntervalMs: doubaoNativeChunkIntervalMs,
        timeoutMs,
        createId,
        WebSocketImpl,
        sleep
      });
    }

    throw new Error(`Unsupported STT provider: ${provider}`);
  };
}

export async function transcribeWithOpenAI(audio, {
  apiKey,
  model,
  language,
  prompt,
  fetchImpl = globalThis.fetch
}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when MONITOR_STT_PROVIDER=openai");
  }

  const form = new FormData();
  form.set("model", model);
  form.set("language", language);
  form.set("prompt", prompt);
  form.set("file", new Blob([audio], { type: "audio/wav" }), "stopwatch-voice.wav");

  const response = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`transcription_failed_${response.status}: ${body.slice(0, 200)}`);
  }

  const result = await response.json();
  return result.text || "";
}

export async function transcribeWithAliyun(audio, {
  apiKey,
  model = defaultAliyunModel,
  fallbackModel = defaultAliyunFallbackModel,
  protocol = "auto",
  url = "",
  audioFormat = "",
  vocabularyId = "",
  language = "zh",
  sampleRate = 16000,
  chunkSize = 3200,
  chunkIntervalMs = 0,
  timeoutMs = 120000,
  createId = randomUUID,
  WebSocketImpl = DefaultWebSocket,
  sleep = defaultSleep
}) {
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY is required when MONITOR_STT_PROVIDER=aliyun");
  }

  const resolvedProtocol = resolveAliyunProtocol({ protocol, model });
  if (resolvedProtocol === "qwen-realtime") {
    try {
      const qwenText = await transcribeWithAliyunQwenRealtime(audio, {
        apiKey,
        model,
        url: url || defaultAliyunQwenRealtimeUrl,
        audioFormat: audioFormat || "pcm",
        language,
        sampleRate,
        chunkSize,
        chunkIntervalMs,
        timeoutMs,
        createId,
        WebSocketImpl,
        sleep
      });
      const normalizedFallbackModel = normalizeAliyunFallbackModel(fallbackModel);
      if (normalizedFallbackModel && shouldRetryWeakQwenTranscript(qwenText, audio, sampleRate)) {
        return transcribeWithAliyunInference(audio, {
          apiKey,
          model: normalizedFallbackModel,
          url: defaultAliyunInferenceUrl,
          audioFormat: "wav",
          vocabularyId,
          language,
          sampleRate,
          chunkSize,
          chunkIntervalMs,
          timeoutMs,
          createId,
          WebSocketImpl,
          sleep
        });
      }
      return qwenText;
    } catch (caught) {
      const normalizedFallbackModel = normalizeAliyunFallbackModel(fallbackModel);
      if (!normalizedFallbackModel) throw caught;
      return transcribeWithAliyunInference(audio, {
        apiKey,
        model: normalizedFallbackModel,
        url: defaultAliyunInferenceUrl,
        audioFormat: "wav",
        vocabularyId,
        language,
        sampleRate,
        chunkSize,
        chunkIntervalMs,
        timeoutMs,
        createId,
        WebSocketImpl,
        sleep
      });
    }
  }

  return transcribeWithAliyunInference(audio, {
    apiKey,
    model,
    url: url || defaultAliyunInferenceUrl,
    audioFormat: audioFormat || "wav",
    vocabularyId,
    language,
    sampleRate,
    chunkSize,
    chunkIntervalMs,
    timeoutMs,
    createId,
    WebSocketImpl,
    sleep
  });
}

export async function transcribeWithDoubao(audio, {
  apiKey,
  model = defaultDoubaoModel,
  url = defaultDoubaoRealtimeUrl,
  resourceId = defaultDoubaoResourceId,
  sampleRate = 16000,
  chunkSize = 3200,
  chunkIntervalMs = 0,
  timeoutMs = 120000,
  WebSocketImpl = DefaultWebSocket,
  sleep = defaultSleep
}) {
  if (!apiKey) {
    throw new Error("DOUBAO_ASR_API_KEY is required when MONITOR_STT_PROVIDER=doubao");
  }

  const audioBuffer = stripWavHeader(Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []));
  if (!audioBuffer.length) return "";

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let audioStarted = false;
    let latestTranscript = "";
    const timeout = setTimeout(() => {
      rejectOnce(new Error(`doubao_transcription_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    function resolveOnce(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      resolve(normalizeTranscriptText(text));
    }

    function rejectOnce(caught) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      reject(caught instanceof Error ? caught : new Error(String(caught)));
    }

    async function sendAudioAndCommit() {
      if (audioStarted) return;
      audioStarted = true;

      try {
        for (let offset = 0; offset < audioBuffer.length; offset += chunkSize) {
          const chunk = audioBuffer.subarray(offset, offset + chunkSize);
          ws.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: chunk.toString("base64")
          }));
          if (chunkIntervalMs > 0) {
            await sleep(chunkIntervalMs);
          }
        }
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch (caught) {
        rejectOnce(caught);
      }
    }

    function handleMessage(data) {
      const message = parseAliyunMessage(data);
      if (!message) return;

      if (message.type === "transcription_session.updated") {
        void sendAudioAndCommit();
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.result") {
        latestTranscript = normalizeTranscriptText(message.transcript || latestTranscript);
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        resolveOnce(message.transcript || latestTranscript);
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.failed" || message.type === "error") {
        const error = message.error || message;
        const code = error.code || error.error_code || "UNKNOWN";
        const errorMessage = error.message || error.error_message || "Doubao transcription failed";
        rejectOnce(new Error(`doubao_transcription_failed_${code}: ${errorMessage}`));
      }
    }

    try {
      ws = new WebSocketImpl(buildRealtimeUrl(url, model), {
        headers: buildDoubaoHeaders({ apiKey, resourceId })
      });
    } catch (caught) {
      rejectOnce(caught);
      return;
    }

    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(buildDoubaoSessionUpdate({ model, sampleRate })));
      } catch (caught) {
        rejectOnce(caught);
      }
    });
    ws.on("message", handleMessage);
    ws.on("error", rejectOnce);
    ws.on("close", () => {
      if (!settled) rejectOnce(new Error("doubao_transcription_connection_closed"));
    });
  });
}

export async function transcribeWithDoubaoNative(audio, {
  appKey,
  accessKey,
  model = defaultDoubaoNativeModel,
  url = defaultDoubaoNativeUrl,
  resourceId = defaultDoubaoNativeResourceId,
  sampleRate = 16000,
  chunkSize = 3200,
  chunkIntervalMs = 0,
  timeoutMs = 120000,
  createId = randomUUID,
  WebSocketImpl = DefaultWebSocket,
  sleep = defaultSleep
}) {
  if (!appKey || !accessKey) {
    throw new Error("DOUBAO_ASR_APP_ID and DOUBAO_ASR_ACCESS_TOKEN are required when MONITOR_STT_PROVIDER=doubao-native");
  }

  const audioBuffer = stripWavHeader(Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []));
  if (!audioBuffer.length) return "";

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let latestTranscript = "";
    let audioFinished = false;
    const timeout = setTimeout(() => {
      rejectOnce(new Error(`doubao_native_transcription_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    function resolveOnce(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      resolve(normalizeTranscriptText(text));
    }

    function rejectOnce(caught) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      reject(caught instanceof Error ? caught : new Error(String(caught)));
    }

    async function sendAudio() {
      try {
        ws.send(buildVolcFullClientRequest(buildDoubaoNativeInitRequest({ model, sampleRate })));
        const totalChunks = Math.max(1, Math.ceil(audioBuffer.length / chunkSize));
        for (let index = 0, offset = 0; offset < audioBuffer.length; index += 1, offset += chunkSize) {
          const chunk = audioBuffer.subarray(offset, offset + chunkSize);
          const isLast = index === totalChunks - 1;
          const sequence = index + 2;
          ws.send(buildVolcAudioOnlyRequest(chunk, isLast ? -sequence : sequence));
          if (chunkIntervalMs > 0 && !isLast) {
            await sleep(chunkIntervalMs);
          }
        }
        audioFinished = true;
      } catch (caught) {
        rejectOnce(caught);
      }
    }

    function handleMessage(data) {
      let frame;
      try {
        frame = parseVolcServerFrame(data);
      } catch (caught) {
        rejectOnce(caught);
        return;
      }

      if (frame.messageType === 0x0f) {
        rejectOnce(new Error(`doubao_native_transcription_failed_${frame.errorCode || "UNKNOWN"}: ${formatDoubaoNativeError(frame.payload)}`));
        return;
      }

      const text = extractDoubaoNativeTranscript(frame.payload);
      if (text) {
        latestTranscript = text;
        resolveOnce(text);
      }
    }

    try {
      ws = new WebSocketImpl(url, {
        headers: {
          "X-Api-App-Key": appKey,
          "X-Api-Access-Key": accessKey,
          "X-Api-Resource-Id": resourceId,
          "X-Api-Connect-Id": createId()
        }
      });
    } catch (caught) {
      rejectOnce(caught);
      return;
    }

    ws.on("open", () => {
      void sendAudio();
    });
    ws.on("message", handleMessage);
    ws.on("error", rejectOnce);
    ws.on("close", () => {
      if (settled) return;
      if (audioFinished) {
        resolveOnce(latestTranscript);
        return;
      }
      rejectOnce(new Error("doubao_native_transcription_connection_closed"));
    });
  });
}

async function transcribeWithAliyunInference(audio, {
  apiKey,
  model,
  url,
  audioFormat,
  vocabularyId,
  language,
  sampleRate,
  chunkSize,
  chunkIntervalMs,
  timeoutMs,
  createId,
  WebSocketImpl,
  sleep
}) {
  const audioBuffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (!audioBuffer.length) return "";

  const taskId = createId();
  const runTask = buildAliyunRunTask({
    taskId,
    model,
    audioFormat,
    sampleRate,
    vocabularyId,
    languageHint: ""
  });
  const finishTask = buildAliyunFinishTask(taskId);

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let audioStarted = false;
    let latestPartialText = "";
    const finalTexts = [];
    const timeout = setTimeout(() => {
      rejectOnce(new Error(`aliyun_transcription_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    function resolveOnce(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      resolve(normalizeTranscriptText(text));
    }

    function rejectOnce(caught) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      reject(caught instanceof Error ? caught : new Error(String(caught)));
    }

    async function sendAudioAndFinish() {
      if (audioStarted) return;
      audioStarted = true;

      try {
        for (let offset = 0; offset < audioBuffer.length; offset += chunkSize) {
          ws.send(audioBuffer.subarray(offset, offset + chunkSize));
          if (chunkIntervalMs > 0) {
            await sleep(chunkIntervalMs);
          }
        }
        ws.send(JSON.stringify(finishTask));
      } catch (caught) {
        rejectOnce(caught);
      }
    }

    function handleMessage(data) {
      const message = parseAliyunMessage(data);
      if (!message) return;

      const event = message.header?.event;
      if (event === "task-started") {
        void sendAudioAndFinish();
        return;
      }

      if (event === "result-generated") {
        const sentence = message.payload?.output?.sentence || {};
        if (sentence.heartbeat) return;

        const text = normalizeTranscriptText(sentence.text);
        if (!text) return;

        latestPartialText = text;
        if (sentence.sentence_end === true || sentence.end_time != null || sentence.endTime != null) {
          finalTexts.push(text);
          latestPartialText = "";
        }
        return;
      }

      if (event === "task-finished") {
        resolveOnce(finalTexts.join(" ") || latestPartialText);
        return;
      }

      if (event === "task-failed") {
        const code = message.header?.error_code || "UNKNOWN";
        const errorMessage = message.header?.error_message || "Aliyun transcription failed";
        rejectOnce(new Error(`aliyun_transcription_failed_${code}: ${errorMessage}`));
      }
    }

    try {
      ws = new WebSocketImpl(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-DashScope-DataInspection": "enable"
        }
      });
    } catch (caught) {
      rejectOnce(caught);
      return;
    }

    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(runTask));
      } catch (caught) {
        rejectOnce(caught);
      }
    });
    ws.on("message", handleMessage);
    ws.on("error", rejectOnce);
    ws.on("close", () => {
      if (!settled) rejectOnce(new Error("aliyun_transcription_connection_closed"));
    });
  });
}

async function transcribeWithAliyunQwenRealtime(audio, {
  apiKey,
  model,
  url,
  audioFormat,
  language,
  sampleRate,
  chunkSize,
  chunkIntervalMs,
  timeoutMs,
  createId,
  WebSocketImpl,
  sleep
}) {
  const audioBuffer = toAliyunQwenAudioBuffer(audio, audioFormat);
  if (!audioBuffer.length) return "";

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let audioStarted = false;
    let latestTranscript = "";
    const timeout = setTimeout(() => {
      rejectOnce(new Error(`aliyun_qwen_transcription_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    function resolveOnce(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      resolve(normalizeTranscriptText(text));
    }

    function rejectOnce(caught) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeQuietly(ws);
      reject(caught instanceof Error ? caught : new Error(String(caught)));
    }

    async function sendAudioAndFinish() {
      if (audioStarted) return;
      audioStarted = true;

      try {
        for (let offset = 0; offset < audioBuffer.length; offset += chunkSize) {
          const chunk = audioBuffer.subarray(offset, offset + chunkSize);
          ws.send(JSON.stringify({
            event_id: createId(),
            type: "input_audio_buffer.append",
            audio: chunk.toString("base64")
          }));
          if (chunkIntervalMs > 0) {
            await sleep(chunkIntervalMs);
          }
        }
        ws.send(JSON.stringify({
          event_id: createId(),
          type: "input_audio_buffer.commit"
        }));
        ws.send(JSON.stringify({
          event_id: createId(),
          type: "session.finish"
        }));
      } catch (caught) {
        rejectOnce(caught);
      }
    }

    function handleMessage(data) {
      const message = parseAliyunMessage(data);
      if (!message) return;

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        latestTranscript = normalizeTranscriptText(message.transcript || latestTranscript);
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.text") {
        latestTranscript = normalizeTranscriptText(`${message.text || ""}${message.stash || ""}`) || latestTranscript;
        return;
      }

      if (message.type === "session.finished") {
        resolveOnce(latestTranscript);
        return;
      }

      if (message.type === "error") {
        const code = message.error?.code || "UNKNOWN";
        const errorMessage = message.error?.message || "Aliyun Qwen transcription failed";
        rejectOnce(new Error(`aliyun_qwen_transcription_failed_${code}: ${errorMessage}`));
      }
    }

    try {
      ws = new WebSocketImpl(buildQwenRealtimeUrl(url, model), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1"
        }
      });
    } catch (caught) {
      rejectOnce(caught);
      return;
    }

    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(buildQwenSessionUpdate({
          eventId: createId(),
          audioFormat,
          sampleRate,
          language
        })));
        void sendAudioAndFinish();
      } catch (caught) {
        rejectOnce(caught);
      }
    });
    ws.on("message", handleMessage);
    ws.on("error", rejectOnce);
    ws.on("close", () => {
      if (!settled) rejectOnce(new Error("aliyun_qwen_transcription_connection_closed"));
    });
  });
}

function buildAliyunRunTask({
  taskId,
  model,
  audioFormat,
  sampleRate,
  vocabularyId,
  languageHint
}) {
  const parameters = {
    format: audioFormat,
    sample_rate: sampleRate
  };

  const normalizedLanguageHint = normalizeAliyunLanguageHint(languageHint);
  if (normalizedLanguageHint) {
    parameters.language_hints = [normalizedLanguageHint];
  }

  const normalizedVocabularyId = String(vocabularyId || "").trim();
  if (normalizedVocabularyId) {
    parameters.vocabulary_id = normalizedVocabularyId;
  }

  return {
    header: {
      action: "run-task",
      task_id: taskId,
      streaming: "duplex"
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model,
      parameters,
      input: {}
    }
  };
}

function buildQwenSessionUpdate({
  eventId,
  audioFormat,
  sampleRate,
  language
}) {
  return {
    event_id: eventId,
    type: "session.update",
    session: {
      modalities: ["text"],
      input_audio_format: audioFormat,
      sample_rate: sampleRate,
      input_audio_transcription: {
        language: normalizeQwenLanguage(language)
      },
      turn_detection: null
    }
  };
}

function buildQwenRealtimeUrl(baseUrl, model) {
  return buildRealtimeUrl(baseUrl, model);
}

function buildRealtimeUrl(baseUrl, model) {
  const url = new URL(baseUrl);
  url.searchParams.set("model", model);
  return url.toString();
}

function buildDoubaoSessionUpdate({ model, sampleRate }) {
  return {
    type: "transcription_session.update",
    session: {
      input_audio_format: "pcm",
      input_audio_codec: "raw",
      input_audio_sample_rate: sampleRate,
      input_audio_bits: 16,
      input_audio_channel: 1,
      input_audio_transcription: {
        model
      }
    }
  };
}

function buildDoubaoHeaders({ apiKey, resourceId }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`
  };
  const normalizedResourceId = String(resourceId || "").trim();
  if (normalizedResourceId) {
    headers["X-Api-Resource-Id"] = normalizedResourceId;
  }
  return headers;
}

function buildDoubaoNativeInitRequest({ model, sampleRate }) {
  return {
    user: {
      uid: "stopwatch-monitor"
    },
    audio: {
      format: "pcm",
      codec: "raw",
      rate: sampleRate,
      bits: 16,
      channel: 1
    },
    request: {
      model_name: model,
      enable_itn: true,
      enable_punc: true,
      show_utterances: true
    }
  };
}

function buildVolcFullClientRequest(payload) {
  return buildVolcFrame({
    messageType: 0x01,
    flags: 0x00,
    serialization: 0x01,
    compression: 0x01,
    payload: Buffer.from(JSON.stringify(payload), "utf8")
  });
}

function buildVolcAudioOnlyRequest(audio, sequence) {
  return buildVolcFrame({
    messageType: 0x02,
    flags: sequence < 0 ? 0x03 : 0x01,
    serialization: 0x00,
    compression: 0x01,
    sequence,
    payload: Buffer.isBuffer(audio) ? audio : Buffer.from(audio || [])
  });
}

function buildVolcFrame({
  messageType,
  flags,
  serialization,
  compression,
  sequence,
  payload
}) {
  const body = compression === 0x01 ? gzipSync(payload) : payload;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  const header = Buffer.from([
    0x11,
    ((messageType & 0x0f) << 4) | (flags & 0x0f),
    ((serialization & 0x0f) << 4) | (compression & 0x0f),
    0x00
  ]);

  if (sequence == null) {
    return Buffer.concat([header, size, body]);
  }

  const sequenceBuffer = Buffer.alloc(4);
  sequenceBuffer.writeInt32BE(sequence, 0);
  return Buffer.concat([header, sequenceBuffer, size, body]);
}

function parseVolcServerFrame(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buffer.length < 8) {
    throw new Error("doubao_native_invalid_response_frame");
  }

  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize;
  let errorCode = null;

  if (flags === 0x01 || flags === 0x02 || flags === 0x03) {
    offset += 4;
  }

  if (messageType === 0x0f) {
    if (offset + 4 > buffer.length) {
      throw new Error("doubao_native_invalid_error_code");
    }
    errorCode = buffer.readInt32BE(offset);
    offset += 4;
  }

  if (offset + 4 > buffer.length) {
    throw new Error("doubao_native_invalid_response_payload_size");
  }

  const payloadSize = buffer.readUInt32BE(offset);
  offset += 4;
  let payload = buffer.subarray(offset, offset + payloadSize);
  if (compression === 0x01) {
    payload = gunzipSync(payload);
  }
  if (serialization === 0x01) {
    payload = JSON.parse(payload.toString("utf8"));
  }
  return {
    messageType,
    flags,
    serialization,
    compression,
    errorCode,
    payload
  };
}

function formatDoubaoNativeError(payload) {
  if (!payload) return "Doubao native transcription failed";
  if (typeof payload === "string") return normalizeTranscriptText(payload);
  return normalizeTranscriptText(
    payload.error?.message ||
    payload.message ||
    payload.error_message ||
    JSON.stringify(payload)
  );
}

function extractDoubaoNativeTranscript(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return normalizeTranscriptText(payload);

  const direct = normalizeTranscriptText(
    payload.result?.text ||
    payload.payload?.result?.text ||
    payload.text ||
    payload.transcript
  );
  if (direct) return direct;

  const utterances = payload.result?.utterances || payload.utterances || payload.payload?.result?.utterances;
  if (Array.isArray(utterances)) {
    return normalizeTranscriptText(utterances.map((item) => item?.text || "").filter(Boolean).join(""));
  }

  const results = payload.result?.results || payload.results || payload.payload?.result?.results;
  if (Array.isArray(results)) {
    return normalizeTranscriptText(results.map((item) => item?.text || item?.transcript || "").filter(Boolean).join(""));
  }

  return "";
}

function buildAliyunFinishTask(taskId) {
  return {
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex"
    },
    payload: {
      input: {}
    }
  };
}

function parseAliyunMessage(data) {
  try {
    if (Buffer.isBuffer(data)) {
      return JSON.parse(data.toString("utf8"));
    }
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "aliyun" || value === "dashscope" || value === "aliyun-dashscope" || value === "alibaba") return "aliyun";
  if (value === "doubao-native" || value === "doubao2" || value === "doubao-2" || value === "seed-asr" || value === "volcengine-native" || value === "bytedance-native") return "doubao-native";
  if (value === "doubao" || value === "volcengine" || value === "volc" || value === "bytedance" || value === "byte") return "doubao";
  if (value === "openai") return value;
  return value || "aliyun";
}

function resolveAliyunProtocol({ protocol, model }) {
  const value = String(protocol || "").trim().toLowerCase();
  if (value === "qwen" || value === "qwen-realtime" || value === "realtime") return "qwen-realtime";
  if (value === "inference" || value === "fun-asr" || value === "paraformer") return "inference";
  return String(model || "").trim().toLowerCase().startsWith("qwen3-asr-") ? "qwen-realtime" : "inference";
}

function normalizeAliyunFallbackModel(model) {
  const value = String(model || "").trim();
  const normalized = value.toLowerCase();
  if (!value || normalized === "0" || normalized === "false" || normalized === "none" || normalized === "off") return "";
  return value;
}

function normalizeAliyunLanguageHint(languageHint) {
  const value = String(languageHint || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "zh" || value === "zh-cn" || value === "zh_cn" || value === "mandarin" || value === "chinese") return "zh";
  if (value === "en" || value === "en-us" || value === "en_us" || value === "english") return "en";
  return value;
}

function normalizeQwenLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  if (!value || value === "zh" || value === "zh-cn" || value === "zh_cn" || value === "mandarin" || value === "chinese") return "zh";
  if (value === "en" || value === "en-us" || value === "en_us" || value === "english") return "en";
  return value;
}

function toAliyunQwenAudioBuffer(audio, audioFormat) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (String(audioFormat || "").toLowerCase() !== "pcm") return buffer;
  return stripWavHeader(buffer);
}

function shouldRetryWeakQwenTranscript(text, audio, sampleRate) {
  const durationMs = estimateAudioDurationMs(audio, sampleRate);
  if (durationMs < 1200) return false;

  const compactText = normalizeTranscriptText(text).replace(/[^\p{L}\p{N}]/gu, "");
  if (!compactText) return true;
  if (compactText.length <= 1) return true;
  if (["对", "嗯", "啊", "哦", "好"].includes(compactText) && durationMs >= 1600) return true;
  return false;
}

function estimateAudioDurationMs(audio, sampleRate) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (!buffer.length || !sampleRate) return 0;

  const wavInfo = readWavInfo(buffer);
  if (wavInfo) {
    const byteRate = wavInfo.sampleRate * wavInfo.channels * wavInfo.bitsPerSample / 8;
    return byteRate > 0 ? Math.round((wavInfo.dataBytes / byteRate) * 1000) : 0;
  }

  return Math.round((buffer.length / (sampleRate * 2)) * 1000);
}

function readWavInfo(buffer) {
  if (buffer.length < 44) return null;
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (buffer.subarray(8, 12).toString("ascii") !== "WAVE") return null;

  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return {
        channels,
        sampleRate,
        bitsPerSample,
        dataBytes: Math.min(chunkSize, Math.max(0, buffer.length - dataStart))
      };
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return {
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes: Math.max(0, buffer.length - 44)
  };
}

function stripWavHeader(buffer) {
  if (buffer.length < 44) return buffer;
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return buffer;
  if (buffer.subarray(8, 12).toString("ascii") !== "WAVE") return buffer;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return buffer.subarray(dataStart, Math.min(dataStart + chunkSize, buffer.length));
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return buffer.subarray(44);
}

function normalizeTranscriptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeQuietly(ws) {
  try {
    ws?.close?.();
  } catch {
    // Ignore close failures after the transcription result has settled.
  }
}
