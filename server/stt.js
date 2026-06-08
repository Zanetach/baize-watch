import { randomUUID } from "node:crypto";
import { WebSocket as DefaultWebSocket } from "ws";

const defaultSttPrompt = "这是一段普通话中文语音，内容是给 Codex 或 Claude Code 的简短指令。请输出简体中文，保留用户原意，不要翻译，不要添加解释。";
const defaultAliyunInferenceUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const defaultAliyunQwenRealtimeUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const defaultAliyunModel = "fun-asr-realtime";
const defaultAliyunFallbackModel = "fun-asr-realtime";

export function resolveSttProvider(env = process.env) {
  const requested = String(env.MONITOR_STT_PROVIDER || "").trim().toLowerCase();
  if (requested) return normalizeProvider(requested);
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
  aliyunLanguageHint = process.env.MONITOR_ALIYUN_LANGUAGE_HINT || "",
  aliyunChunkSize = parsePositiveInt(process.env.MONITOR_ALIYUN_CHUNK_SIZE, 3200),
  aliyunChunkIntervalMs = parseNonNegativeInt(process.env.MONITOR_ALIYUN_CHUNK_INTERVAL_MS, 100),
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
  language = "zh",
  sampleRate = 16000,
  chunkSize = 3200,
  chunkIntervalMs = 100,
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
      return await transcribeWithAliyunQwenRealtime(audio, {
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
    } catch (caught) {
      const normalizedFallbackModel = normalizeAliyunFallbackModel(fallbackModel);
      if (!normalizedFallbackModel) throw caught;
      return transcribeWithAliyunInference(audio, {
        apiKey,
        model: normalizedFallbackModel,
        url: defaultAliyunInferenceUrl,
        audioFormat: "wav",
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

async function transcribeWithAliyunInference(audio, {
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
  const audioBuffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (!audioBuffer.length) return "";

  const taskId = createId();
  const runTask = buildAliyunRunTask({
    taskId,
    model,
    audioFormat,
    sampleRate,
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
  const url = new URL(baseUrl);
  url.searchParams.set("model", model);
  return url.toString();
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
