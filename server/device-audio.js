export function sendPcmSpeechToDevices(clients, {
  audio,
  sampleRate = 16000,
  format = "pcm_s16le",
  text = ""
} = {}, {
  chunkBytes = 2048,
  gain = 1,
  after = "",
  agent = ""
} = {}) {
  const raw = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  const data = format === "pcm_s16le" ? applyPcm16Gain(raw, gain) : Buffer.from(raw);
  if (!data.length) return 0;

  let sentDevices = 0;
  for (const ws of clients || []) {
    if (ws?.role !== "device" || ws.readyState !== ws.OPEN) continue;
    const startMessage = { type: "tts_start", sampleRate, format, text };
    if (after) startMessage.after = after;
    if (agent) startMessage.agent = agent;
    ws.send(JSON.stringify(startMessage));
    for (let offset = 0; offset < data.length; offset += chunkBytes) {
      ws.send(JSON.stringify({
        type: "tts_audio",
        audio: data.subarray(offset, offset + chunkBytes).toString("base64")
      }));
    }
    ws.send(JSON.stringify({ type: "tts_done" }));
    sentDevices++;
  }

  return sentDevices;
}

const PCM16_OUTPUT_LIMIT = 31500;

export function applyPcm16Gain(pcm, gain = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
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
    const offset = index * 2;
    boosted.writeInt16LE(clampPcm16(Math.round(scaledSamples[index] * limiter)), offset);
  }

  return boosted;
}

function clampPcm16(value) {
  return Math.max(-32768, Math.min(32767, value));
}
