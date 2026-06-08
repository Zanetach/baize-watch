export const defaultVoiceConfig = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  gain: 1,
  maxRecordingMs: 30000
});

export function createVoiceController({
  transcribeAudio,
  pasteText,
  pressReturn,
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

  function start({ agent = activeAgent } = {}) {
    state = "recording";
    chunks = [];
    activeAgent = agent;
    startedAt = now();
    lastText = "";
    error = null;
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
    const pcm = Buffer.concat(chunks);
    chunks = [];

    if (!pcm.length) {
      state = "idle";
      startedAt = null;
      return { ...status(), state: "empty" };
    }

    state = "transcribing";
    try {
      const wav = makeWavBuffer(applyPcm16Gain(pcm, voiceConfig.gain), voiceConfig);
      const text = normalizeTranscript(await transcribeAudio(wav, {
        agent: activeAgent,
        sampleRate: voiceConfig.sampleRate,
        channels: voiceConfig.channels,
        bitsPerSample: voiceConfig.bitsPerSample
      }));

      lastText = text;
      if (text) {
        await pasteText(text);
        state = "ready";
      } else {
        state = "idle";
      }
      startedAt = null;
      return status();
    } catch (caught) {
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
    return status();
  }

  function status() {
    return {
      state,
      agent: activeAgent,
      startedAt,
      durationMs: state === "recording" && startedAt ? now() - startedAt : 0,
      bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      text: lastText,
      error
    };
  }

  return { start, appendAudio, stop, send, status };
}

export function applyPcm16Gain(pcm, gain = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const numericGain = Number(gain);

  if (!Number.isFinite(numericGain) || numericGain === 1) {
    return Buffer.from(data);
  }

  const boosted = Buffer.from(data);
  const sampleBytes = boosted.length - (boosted.length % 2);
  for (let offset = 0; offset < sampleBytes; offset += 2) {
    const sample = boosted.readInt16LE(offset);
    const scaled = Math.round(sample * numericGain);
    boosted.writeInt16LE(clampPcm16(scaled), offset);
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
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampPcm16(value) {
  return Math.max(-32768, Math.min(32767, value));
}
