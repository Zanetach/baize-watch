import { interpretVoiceCommand, normalizeVoiceCommand } from "./voice-intent.js";

export const defaultVoiceConfig = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  gain: 1,
  minRecordingMs: 900,
  minRms: 0,
  maxRecordingMs: 30000
});

const PCM16_OUTPUT_LIMIT = 28000;

export function createVoiceController({
  transcribeAudio,
  pasteText,
  pressReturn,
  shouldPasteTranscript = () => true,
  onTranscribeAudio = async () => {},
  now = () => Date.now(),
  config = {}
}) {
  const voiceConfig = { ...defaultVoiceConfig, ...config };
  let state = "idle";
  let chunks = [];
  let activeAgent = "codex";
  let startedAt = null;
  let lastText = "";
  let error = null;
  let lastAudio = null;
  let lastIntent = null;
  let lastPreparedForAgent = false;
  let asrStartedAt = null;
  let lastAsrLatencyMs = null;
  let generation = 0;

  function start({ agent = activeAgent } = {}) {
    generation++;
    state = "recording";
    chunks = [];
    activeAgent = agent;
    startedAt = now();
    lastText = "";
    error = null;
    lastAudio = null;
    lastIntent = null;
    lastPreparedForAgent = false;
    asrStartedAt = null;
    lastAsrLatencyMs = null;
    return status();
  }

  function appendAudio(chunk) {
    if (state !== "recording") return false;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buffer.length) return false;
    chunks.push(buffer);
    return true;
  }

  async function stop() {
    if (state !== "recording") return status();
    const stopGeneration = generation;
    const pcm = Buffer.concat(chunks);
    const durationMs = startedAt ? Math.max(0, now() - startedAt) : 0;
    lastAudio = analyzePcm16(pcm, durationMs);
    chunks = [];

    if (!pcm.length) {
      state = "idle";
      startedAt = null;
      return { ...status(), state: "empty" };
    }

    if (durationMs < voiceConfig.minRecordingMs) {
      state = "too_short";
      error = `recording_too_short_${durationMs}ms`;
      startedAt = null;
      return status();
    }

    if (voiceConfig.minRms > 0 && lastAudio.rms < voiceConfig.minRms) {
      state = "too_quiet";
      error = `recording_too_quiet_rms_${lastAudio.rms}`;
      startedAt = null;
      return status();
    }

    state = "transcribing";
    asrStartedAt = now();
    lastAsrLatencyMs = null;
    try {
      const wav = makeWavBuffer(applyPcm16Gain(pcm, voiceConfig.gain), voiceConfig);
      await onTranscribeAudio(wav, {
        agent: activeAgent,
        sampleRate: voiceConfig.sampleRate,
        channels: voiceConfig.channels,
        bitsPerSample: voiceConfig.bitsPerSample,
        audio: lastAudio
      });
      const rawText = await transcribeAudio(wav, {
        agent: activeAgent,
        sampleRate: voiceConfig.sampleRate,
        channels: voiceConfig.channels,
        bitsPerSample: voiceConfig.bitsPerSample
      });
      if (stopGeneration !== generation) {
        return status();
      }
      lastAsrLatencyMs = Math.max(0, now() - asrStartedAt);
      asrStartedAt = null;
      const intent = interpretVoiceCommand(rawText, { agent: activeAgent });
      if (intent.targetAgent) {
        activeAgent = normalizeAgentKey(intent.targetAgent);
      }
      const text = intent.normalized;
      const shouldPaste = Boolean(text) &&
        Boolean(await shouldPasteTranscript({ text, intent, agent: activeAgent }));
      if (stopGeneration !== generation) {
        return status();
      }

      lastIntent = intent;
      lastText = text;
      lastPreparedForAgent = shouldPaste;
      if (shouldPaste) {
        await pasteText(text, { intent, agent: activeAgent });
        state = "ready";
      } else if (text) {
        state = "idle";
      } else {
        state = "idle";
      }
      startedAt = null;
      return status();
    } catch (caught) {
      lastAsrLatencyMs = asrStartedAt === null ? lastAsrLatencyMs : Math.max(0, now() - asrStartedAt);
      asrStartedAt = null;
      error = caught instanceof Error ? caught.message : String(caught);
      state = "error";
      startedAt = null;
      return status();
    }
  }

  async function send() {
    if (state !== "ready" || !lastText) return status();
    await pressReturn();
    state = "idle";
    lastText = "";
    error = null;
    lastAudio = null;
    lastIntent = null;
    lastPreparedForAgent = false;
    asrStartedAt = null;
    lastAsrLatencyMs = null;
    return status();
  }

  async function prepareText(text, {
    agent = activeAgent,
    intent = { action: "manual" }
  } = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return status();

    generation++;
    chunks = [];
    startedAt = null;
    activeAgent = normalizeAgentKey(agent);
    lastText = normalizedText;
    lastIntent = intent;
    lastPreparedForAgent = true;
    error = null;
    lastAudio = null;
    asrStartedAt = null;
    lastAsrLatencyMs = null;
    await pasteText(normalizedText, { intent, agent: activeAgent });
    state = "ready";
    return status();
  }

  function cancel() {
    generation++;
    state = "idle";
    chunks = [];
    startedAt = null;
    lastText = "";
    error = null;
    lastAudio = null;
    lastIntent = null;
    lastPreparedForAgent = false;
    asrStartedAt = null;
    lastAsrLatencyMs = null;
    return status();
  }

  function status() {
    return {
      state,
      agent: activeAgent,
      startedAt,
      durationMs: state === "recording" && startedAt ? now() - startedAt : 0,
      bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      audio: lastAudio,
      asr: asrStatus(),
      intent: lastIntent,
      preparedForAgent: lastPreparedForAgent,
      text: lastText,
      error
    };
  }

  function asrStatus() {
    const elapsedMs = asrStartedAt === null
      ? lastAsrLatencyMs
      : Math.max(0, now() - asrStartedAt);
    return {
      startedAt: asrStartedAt,
      latencyMs: lastAsrLatencyMs,
      elapsedMs
    };
  }

  return { start, appendAudio, stop, prepareText, send, cancel, status };
}

export function analyzePcm16(pcm, durationMs = 0) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const sampleBytes = data.length - (data.length % 2);
  const samples = sampleBytes / 2;
  let peak = 0;
  let clippedSamples = 0;
  let sumSquares = 0;

  for (let offset = 0; offset < sampleBytes; offset += 2) {
    const sample = data.readInt16LE(offset);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    if (abs >= 32760) clippedSamples++;
    sumSquares += sample * sample;
  }

  const rms = samples ? Math.round(Math.sqrt(sumSquares / samples)) : 0;

  return {
    durationMs,
    bytes: data.length,
    samples,
    rms,
    peak,
    clippedSamples
  };
}

export function applyPcm16Gain(pcm, gain = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const numericGain = Number(gain);

  if (!Number.isFinite(numericGain) || numericGain <= 0) {
    return Buffer.from(data);
  }

  const boosted = Buffer.from(data);
  const sampleBytes = boosted.length - (boosted.length % 2);
  const scaledSamples = [];
  let peak = 0;

  for (let offset = 0; offset < sampleBytes; offset += 2) {
    const sample = boosted.readInt16LE(offset);
    const scaled = Math.round(sample * numericGain);
    scaledSamples.push(scaled);
    peak = Math.max(peak, Math.abs(scaled));
  }

  const limiter = peak > PCM16_OUTPUT_LIMIT ? PCM16_OUTPUT_LIMIT / peak : 1;
  for (let index = 0; index < scaledSamples.length; index++) {
    boosted.writeInt16LE(clampPcm16(Math.round(scaledSamples[index] * limiter)), index * 2);
  }

  return boosted;
}

export function makeWavBuffer(pcm, {
  sampleRate = defaultVoiceConfig.sampleRate,
  channels = defaultVoiceConfig.channels,
  bitsPerSample = defaultVoiceConfig.bitsPerSample
} = {}) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

export function normalizeTranscript(value) {
  return normalizeVoiceCommand(value);
}

function clampPcm16(value) {
  return Math.max(-32768, Math.min(32767, value));
}

function normalizeAgentKey(value) {
  return String(value || "").toLowerCase() === "claude" ? "claude" : "codex";
}
