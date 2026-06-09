import { randomUUID } from "node:crypto";
import { WebSocket as DefaultWebSocket } from "ws";

const defaultDoubaoTtsUrl = "wss://ai-gateway.vei.volces.com/v1/realtime";
const defaultDoubaoTtsModel = "doubao-tts";
const defaultDoubaoVoice = "zh_female_kailangjiejie_moon_bigtts";
const defaultDoubaoSpeechTtsUrl = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse";
const defaultDoubaoSpeechResourceId = "seed-tts-2.0";
const defaultDoubaoSpeechVoice = "zh_female_jiaochuannv_uranus_bigtts";
const defaultAliyunTtsUrl = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
const defaultAliyunTtsModel = "cosyvoice-v3-flash";
const defaultAliyunVoice = "longwanjun_v3";

export function createDoubaoTtsSynthesizer(options = {}) {
  const apiKey = options.apiKey ?? process.env.DOUBAO_TTS_API_KEY ?? process.env.DOUBAO_API_KEY ?? process.env.VOLCENGINE_TTS_API_KEY ?? "";
  const protocol = resolveDoubaoTtsProtocol({
    protocol: options.protocol ?? process.env.MONITOR_DOUBAO_TTS_PROTOCOL ?? process.env.DOUBAO_TTS_PROTOCOL,
    apiKey,
    url: options.url ?? process.env.MONITOR_DOUBAO_TTS_URL ?? process.env.DOUBAO_TTS_URL
  });
  const url = options.url ?? process.env.MONITOR_DOUBAO_TTS_URL ?? process.env.DOUBAO_TTS_URL ?? (
    protocol === "speech" ? defaultDoubaoSpeechTtsUrl : defaultDoubaoTtsUrl
  );
  const model = options.model ?? process.env.DOUBAO_TTS_MODEL ?? defaultDoubaoTtsModel;
  const resourceId = options.resourceId ?? process.env.MONITOR_DOUBAO_TTS_RESOURCE_ID ?? process.env.DOUBAO_TTS_RESOURCE_ID ?? defaultDoubaoSpeechResourceId;
  const voice = options.voice ?? process.env.DOUBAO_TTS_VOICE ?? (
    protocol === "speech" ? defaultDoubaoSpeechVoice : defaultDoubaoVoice
  );
  const sampleRate = Number.parseInt(String(options.sampleRate ?? process.env.DOUBAO_TTS_SAMPLE_RATE ?? "16000"), 10);
  const createId = options.createId ?? randomUUID;
  const WebSocketImpl = options.WebSocketImpl ?? DefaultWebSocket;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async function synthesize(text) {
    if (protocol === "speech") {
      return synthesizeDoubaoSpeechApiKey(text, {
        apiKey,
        resourceId,
        voice,
        url,
        sampleRate,
        createId,
        fetchImpl
      });
    }

    return synthesizeDoubaoSpeech(text, {
      apiKey,
      model,
      voice,
      url,
      sampleRate,
      createId,
      WebSocketImpl
    });
  };
}

export function createAliyunTtsSynthesizer({
  apiKey = process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_DASHSCOPE_API_KEY || process.env.MONITOR_ALIYUN_API_KEY || process.env.ALIYUN_API_KEY || "",
  model = process.env.MONITOR_ALIYUN_TTS_MODEL || process.env.ALIYUN_TTS_MODEL || process.env.DASHSCOPE_TTS_MODEL || defaultAliyunTtsModel,
  voice = process.env.MONITOR_ALIYUN_TTS_VOICE || process.env.ALIYUN_TTS_VOICE || process.env.DASHSCOPE_TTS_VOICE || defaultAliyunVoice,
  url = process.env.MONITOR_ALIYUN_TTS_URL || process.env.ALIYUN_TTS_URL || defaultAliyunTtsUrl,
  sampleRate = Number.parseInt(process.env.MONITOR_ALIYUN_TTS_SAMPLE_RATE || process.env.ALIYUN_TTS_SAMPLE_RATE || "16000", 10),
  volume = Number.parseInt(process.env.MONITOR_ALIYUN_TTS_VOLUME || process.env.ALIYUN_TTS_VOLUME || "80", 10),
  fetchImpl = globalThis.fetch
} = {}) {
  return async function synthesize(text, options = {}) {
    return synthesizeAliyunSpeech(text, {
      apiKey,
      model,
      voice,
      url,
      sampleRate,
      volume: numberOption(options.volume, volume),
      fetchImpl
    });
  };
}

export function createCachedSpeechSynthesizer(synthesize) {
  const cache = new Map();

  return async function synthesizeCached(text, options = {}) {
    const cacheKey = String(options.cacheKey || "").trim();
    if (!cacheKey) return synthesize(text, options);

    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, Promise.resolve(synthesize(text, options)).then(cloneSpeech));
    }

    return cloneSpeech(await cache.get(cacheKey));
  };
}

export async function synthesizeDoubaoSpeech(text, {
  apiKey,
  model = defaultDoubaoTtsModel,
  voice = defaultDoubaoVoice,
  url = defaultDoubaoTtsUrl,
  sampleRate = 16000,
  createId = randomUUID,
  WebSocketImpl = DefaultWebSocket
} = {}) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return { audio: Buffer.alloc(0), sampleRate, format: "pcm_s16le" };
  if (!apiKey) throw new Error("DOUBAO_TTS_API_KEY is required when MONITOR_TTS_PROVIDER=doubao");

  const wsUrl = buildDoubaoTtsUrl(url, model);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let ws;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        if (ws && typeof ws.close === "function") ws.close();
      } catch {
        // Closing after completion is best-effort.
      }
      fn(value);
    };

    const rejectOnce = (caught) => settle(reject, caught instanceof Error ? caught : new Error(String(caught)));

    ws = new WebSocketImpl(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(buildSessionUpdate({ eventId: createId(), model, voice, sampleRate })));
        ws.send(JSON.stringify({ event_id: createId(), type: "input_text.append", delta: normalizedText }));
        ws.send(JSON.stringify({ event_id: createId(), type: "input_text.done" }));
      } catch (caught) {
        rejectOnce(caught);
      }
    });

    ws.on("message", (raw) => {
      const event = parseJson(raw);
      if (!event) return;
      if (event.type === "response.audio.delta" && event.delta) {
        chunks.push(Buffer.from(String(event.delta), "base64"));
        return;
      }
      if (event.type === "response.audio.done") {
        settle(resolve, {
          audio: Buffer.concat(chunks),
          sampleRate,
          format: "pcm_s16le"
        });
        return;
      }
      if (event.type === "error") {
        rejectOnce(new Error(`doubao_tts_error: ${event.error?.message || JSON.stringify(event)}`));
      }
    });

    ws.on("error", rejectOnce);
    ws.on("close", () => {
      if (!settled) rejectOnce(new Error("doubao_tts_connection_closed"));
    });
  });
}

export async function synthesizeDoubaoSpeechApiKey(text, {
  apiKey,
  resourceId = defaultDoubaoSpeechResourceId,
  voice = defaultDoubaoSpeechVoice,
  url = defaultDoubaoSpeechTtsUrl,
  sampleRate = 16000,
  uid = "stopwatch-monitor",
  createId = randomUUID,
  fetchImpl = globalThis.fetch
} = {}) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return { audio: Buffer.alloc(0), sampleRate, format: "pcm_s16le" };
  if (!apiKey) throw new Error("DOUBAO_TTS_API_KEY is required when MONITOR_TTS_PROVIDER=doubao");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for Doubao speech TTS");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": createId()
    },
    body: JSON.stringify({
      user: {
        uid
      },
      req_params: {
        text: normalizedText,
        speaker: voice,
        audio_params: {
          format: "pcm",
          sample_rate: sampleRate
        }
      }
    })
  });

  const bodyText = typeof response.text === "function" ? await response.text() : "";
  if (!response.ok) {
    const status = response.status || 502;
    throw new Error(`doubao_tts_failed_${status}: ${bodyText.slice(0, 200)}`);
  }

  const { audio, error } = parseDoubaoSpeechTtsAudio(bodyText);
  if (audio.length) return { audio, sampleRate, format: "pcm_s16le" };
  if (error) throw new Error(`doubao_tts_error: ${error}`);
  throw new Error("doubao_tts_empty_audio");
}

export async function synthesizeAliyunSpeech(text, {
  apiKey,
  model = defaultAliyunTtsModel,
  voice = defaultAliyunVoice,
  url = defaultAliyunTtsUrl,
  sampleRate = 16000,
  volume = 80,
  fetchImpl = globalThis.fetch
} = {}) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return { audio: Buffer.alloc(0), sampleRate, format: "pcm_s16le" };
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is required when MONITOR_TTS_PROVIDER=aliyun");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for Aliyun TTS");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "X-DashScope-SSE": "enable"
    },
    body: JSON.stringify({
      model,
      input: {
        text: normalizedText,
        voice,
        format: "pcm",
        sample_rate: sampleRate,
        volume
      }
    })
  });

  const bodyText = typeof response.text === "function" ? await response.text() : "";
  if (!response.ok) {
    const status = response.status || 502;
    throw new Error(`aliyun_tts_failed_${status}: ${bodyText.slice(0, 160)}`);
  }

  const audio = parseAliyunTtsAudio(bodyText);
  if (!audio.length) throw new Error("aliyun_tts_empty_audio");
  return { audio, sampleRate, format: "pcm_s16le" };
}

function buildSessionUpdate({ eventId, model, voice, sampleRate }) {
  return {
    event_id: eventId,
    type: "tts_session.update",
    session: {
      voice,
      output_audio_format: "pcm",
      output_audio_sample_rate: sampleRate,
      text_to_speech: { model }
    }
  };
}

function buildDoubaoTtsUrl(baseUrl, model) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("model", model);
  return parsed.toString();
}

function resolveDoubaoTtsProtocol({ protocol, apiKey, url }) {
  const normalized = String(protocol || "").trim().toLowerCase();
  if (["gateway", "realtime", "ai-gateway", "websocket", "ws"].includes(normalized)) return "gateway";
  if (["speech", "openspeech", "api-key", "apikey", "http", "sse"].includes(normalized)) return "speech";
  if (String(url || "").includes("openspeech.bytedance.com")) return "speech";
  if (isUuidApiKey(apiKey)) return "speech";
  return "gateway";
}

function isUuidApiKey(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function parseJson(raw) {
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch {
    return null;
  }
}

function parseAliyunTtsAudio(bodyText) {
  const chunks = [];
  for (const payload of parseServerSentEventData(bodyText)) {
    if (!payload || payload === "[DONE]") continue;
    const event = parseJson(payload);
    const data = event?.output?.audio?.data;
    if (data) chunks.push(Buffer.from(String(data), "base64"));
  }
  return Buffer.concat(chunks);
}

function parseDoubaoSpeechTtsAudio(bodyText) {
  const chunks = [];
  let error = "";

  for (const payload of parseServerSentEventData(bodyText)) {
    if (!payload || payload === "[DONE]") continue;
    const event = parseJson(payload);
    if (!event) continue;

    const eventError = getDoubaoSpeechError(event);
    if (eventError) error = eventError;

    chunks.push(...extractDoubaoSpeechAudioChunks(event));
  }

  return { audio: Buffer.concat(chunks), error };
}

function getDoubaoSpeechError(event) {
  const code = event?.code ?? event?.error_code ?? event?.status_code ?? event?.error?.code;
  const numericCode = Number(code);
  const failedCode = code !== undefined && (!Number.isFinite(numericCode) || (numericCode !== 0 && numericCode !== 20000000));
  if (!failedCode && !event?.error) return "";

  const message = event?.message || event?.error_message || event?.error?.message || JSON.stringify(event).slice(0, 160);
  return `${code ?? "UNKNOWN"}: ${message}`;
}

function extractDoubaoSpeechAudioChunks(value, key = "") {
  if (typeof value === "string") {
    const decoded = shouldDecodeAudioField(key, value) ? decodeBase64Audio(value, key === "data" ? 16 : 4) : null;
    return decoded ? [decoded] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractDoubaoSpeechAudioChunks(item, key));
  }

  if (!value || typeof value !== "object") return [];

  const chunks = [];
  for (const [childKey, childValue] of Object.entries(value)) {
    chunks.push(...extractDoubaoSpeechAudioChunks(childValue, childKey.toLowerCase()));
  }
  return chunks;
}

function shouldDecodeAudioField(key, value) {
  const normalizedKey = String(key || "").toLowerCase();
  if (normalizedKey.includes("audio") || normalizedKey.includes("pcm") || normalizedKey.includes("payload")) return true;
  return normalizedKey === "data" && String(value || "").trim().length >= 16;
}

function decodeBase64Audio(value, minLength) {
  const normalized = String(value || "").trim();
  if (normalized.length < minLength || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized)) return null;
  try {
    const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(base64, "base64");
    return decoded.length ? decoded : null;
  } catch {
    return null;
  }
}

function parseServerSentEventData(bodyText) {
  const payloads = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    payloads.push(current.join("\n"));
    current = [];
  };

  for (const line of String(bodyText || "").split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      current.push(line.slice("data:".length).trimStart());
      continue;
    }
    if (line.trimStart().startsWith("{")) {
      flush();
      payloads.push(line.trim());
    }
  }
  flush();
  return payloads;
}

function numberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneSpeech(speech = {}) {
  return {
    ...speech,
    audio: Buffer.isBuffer(speech.audio)
      ? Buffer.from(speech.audio)
      : Buffer.from(speech.audio || [])
  };
}
