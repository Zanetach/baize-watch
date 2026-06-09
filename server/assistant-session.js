export const defaultWakeGreeting = "我是傻妞，你的智能秘书。";

export function wakeGreetingText(env = process.env) {
  const configured = String(env.MONITOR_WAKE_GREETING || "").trim();
  return configured || defaultWakeGreeting;
}

export function wakeSpeechOptions(agent) {
  return {
    agent: normalizeVoiceAgent(agent),
    after: "listen",
    profile: "wake"
  };
}

export function shouldUseDeviceWakeCue(env = process.env) {
  const normalized = String(env.MONITOR_DEVICE_WAKE_CUE ?? "0").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function shouldAcceptVoiceWake({
  voiceState = "idle",
  nowMs = Date.now(),
  deviceSpeechBusyUntilMs = 0,
  speechInFlight = false
} = {}) {
  if (speechInFlight) return false;
  if (nowMs < deviceSpeechBusyUntilMs) return false;
  return voiceState === "idle";
}

export function shouldAcceptVoiceStart({
  mode = "",
  conversationActive = true,
  nowMs = Date.now(),
  deviceSpeechBusyUntilMs = 0,
  deviceSpeechInFlight = false,
  assistantTurnInFlight = false
} = {}) {
  if (deviceSpeechInFlight || assistantTurnInFlight) return false;
  if (String(mode || "") === "continue" && !conversationActive) return false;
  if (nowMs < deviceSpeechBusyUntilMs) {
    return String(mode || "") === "continue";
  }
  return true;
}

export function normalizeVoiceMode(mode = "") {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "continue") return "continue";
  if (normalized === "dictate") return "dictate";
  return normalized || "manual";
}

export function isConversationVoiceMode({
  mode = "",
  conversationActive = false
} = {}) {
  return Boolean(conversationActive) && normalizeVoiceMode(mode) === "continue";
}

export function shouldRepromptAfterEmptyTranscript(status = {}, {
  conversationActive = true,
  minDurationMs = 1200,
  minRms = 500
} = {}) {
  if (!conversationActive) return false;
  if (status?.text) return false;
  if (status?.state !== "idle") return false;

  const audio = status?.audio || {};
  const durationMs = Number(audio.durationMs || 0);
  const rms = Number(audio.rms || 0);
  return durationMs >= minDurationMs && rms >= minRms;
}

export function speechOptionsForAssistantStatus(status = {}) {
  return {
    agent: normalizeVoiceAgent(status.agent),
    after: shouldContinueConversation(status) ? "listen" : "idle"
  };
}

export function shouldContinueConversation(status = {}) {
  return Boolean(status.text) &&
    !status.preparedForAgent &&
    status.state === "idle" &&
    !shouldExitConversation(status.intent);
}

export function shouldPrepareAgentCommand(intent = {}) {
  return intent?.action === "develop" ||
    intent?.action === "ask" ||
    intent?.action === "agent" ||
    intent?.action === "dictate";
}

export function shouldUseFocusedDictation({
  assistantEnabled = true,
  focusedTextInput = false,
  intent = {}
} = {}) {
  return Boolean(assistantEnabled) &&
    Boolean(focusedTextInput) &&
    intent?.action === "unknown" &&
    !shouldExitConversation(intent);
}

export function shouldPasteRecognizedSpeech({
  assistantEnabled = true,
  focusedDictationEnabled = true,
  focusedTextInput = false,
  conversationActive = false,
  intent = {}
} = {}) {
  if (!assistantEnabled) return true;
  if (conversationActive) return false;
  if (shouldPrepareAgentCommand(intent)) return true;
  if (!focusedDictationEnabled) return false;
  return shouldUseFocusedDictation({
    assistantEnabled,
    focusedTextInput,
    intent
  });
}

export function shouldSilenceFocusedDictation(status = {}) {
  return Boolean(status.preparedForAgent) &&
    status.state === "ready" &&
    status.intent?.action === "unknown";
}

export function shouldResumeListeningAfterPreparedInput(status = {}, {
  conversationActive = true
} = {}) {
  return false;
}

export function shouldExitConversation(intent = {}) {
  return intent?.action === "exit_conversation";
}

export function voiceStatusWithAssistantProcessing(voiceStatus = {}, {
  active = false,
  agent,
  startedAt = 0,
  nowMs = Date.now()
} = {}) {
  if (!active) return voiceStatus;
  if (voiceStatus?.state && voiceStatus.state !== "idle") return voiceStatus;

  const started = Number(startedAt);
  const now = Number(nowMs);
  const elapsedMs = Number.isFinite(started) && Number.isFinite(now) && started > 0
    ? Math.max(0, now - started)
    : 0;

  return {
    ...voiceStatus,
    state: "thinking",
    agent: normalizeVoiceAgent(agent || voiceStatus.agent),
    assistant: {
      elapsedMs
    }
  };
}

export function normalizeVoiceAgent(agent) {
  const normalized = String(agent || "").toLowerCase();
  return normalized === "claude" || normalized === "claude-code" ? "claude" : "codex";
}
