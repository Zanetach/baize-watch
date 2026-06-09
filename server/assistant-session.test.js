import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWakeGreeting,
  isConversationVoiceMode,
  normalizeVoiceMode,
  shouldAcceptVoiceWake,
  shouldContinueConversation,
  shouldExitConversation,
  shouldPrepareAgentCommand,
  shouldResumeListeningAfterPreparedInput,
  shouldSilenceFocusedDictation,
  shouldPasteRecognizedSpeech,
  shouldUseFocusedDictation,
  shouldAcceptVoiceStart,
  shouldRepromptAfterEmptyTranscript,
  shouldUseDeviceWakeCue,
  speechOptionsForAssistantStatus,
  voiceStatusWithAssistantProcessing,
  wakeGreetingText,
  wakeSpeechOptions
} from "./assistant-session.js";

test("wake greeting introduces Shaniu as the super secretary", () => {
  assert.equal(defaultWakeGreeting, "我是傻妞，你的智能秘书。");
  assert.equal(wakeGreetingText({ MONITOR_WAKE_GREETING: "" }), defaultWakeGreeting);
  assert.equal(wakeGreetingText({ MONITOR_WAKE_GREETING: "我是傻妞，你的智能秘书。" }), "我是傻妞，你的智能秘书。");
});

test("wake speech asks the device to resume listening after the greeting", () => {
  assert.deepEqual(wakeSpeechOptions("claude"), {
    agent: "claude",
    after: "listen",
    profile: "wake"
  });
});

test("cloud wake speech is enabled by default and device wake cue is opt-in", () => {
  assert.equal(shouldUseDeviceWakeCue({}), false);
  assert.equal(shouldUseDeviceWakeCue({ MONITOR_DEVICE_WAKE_CUE: "1" }), true);
  assert.equal(shouldUseDeviceWakeCue({ MONITOR_DEVICE_WAKE_CUE: "true" }), true);
  assert.equal(shouldUseDeviceWakeCue({ MONITOR_DEVICE_WAKE_CUE: "0" }), false);
  assert.equal(shouldUseDeviceWakeCue({ MONITOR_DEVICE_WAKE_CUE: "off" }), false);
});

test("duplicate voice wake is rejected while speech playback or voice capture is busy", () => {
  assert.equal(shouldAcceptVoiceWake({
    voiceState: "idle",
    nowMs: 1000,
    deviceSpeechBusyUntilMs: 2500
  }), false);
  assert.equal(shouldAcceptVoiceWake({
    voiceState: "recording",
    nowMs: 3000,
    deviceSpeechBusyUntilMs: 0
  }), false);
  assert.equal(shouldAcceptVoiceWake({
    voiceState: "idle",
    nowMs: 3000,
    speechInFlight: true,
    deviceSpeechBusyUntilMs: 0
  }), false);
  assert.equal(shouldAcceptVoiceWake({
    voiceState: "idle",
    nowMs: 3000,
    deviceSpeechBusyUntilMs: 2500
  }), true);
});

test("voice start from after-listen TTS is accepted during the playback grace window", () => {
  assert.equal(shouldAcceptVoiceStart({
    mode: "continue",
    conversationActive: true,
    nowMs: 1100,
    deviceSpeechBusyUntilMs: 1600,
    deviceSpeechInFlight: false,
    assistantTurnInFlight: false
  }), true);
});

test("continued voice starts are rejected after conversation has exited", () => {
  assert.equal(shouldAcceptVoiceStart({
    mode: "continue",
    conversationActive: false,
    nowMs: 2000,
    deviceSpeechBusyUntilMs: 0,
    deviceSpeechInFlight: false,
    assistantTurnInFlight: false
  }), false);
});

test("manual voice start is still rejected while speech is busy", () => {
  assert.equal(shouldAcceptVoiceStart({
    mode: "",
    nowMs: 1100,
    deviceSpeechBusyUntilMs: 1600,
    deviceSpeechInFlight: false,
    assistantTurnInFlight: false
  }), false);
  assert.equal(shouldAcceptVoiceStart({
    mode: "continue",
    nowMs: 1100,
    deviceSpeechBusyUntilMs: 1600,
    deviceSpeechInFlight: true,
    assistantTurnInFlight: false
  }), false);
});

test("voice modes separate dictation from continuous conversation", () => {
  assert.equal(normalizeVoiceMode("continue"), "continue");
  assert.equal(normalizeVoiceMode("dictate"), "dictate");
  assert.equal(normalizeVoiceMode(""), "manual");
  assert.equal(isConversationVoiceMode({
    mode: "continue",
    conversationActive: true
  }), true);
  assert.equal(isConversationVoiceMode({
    mode: "dictate",
    conversationActive: true
  }), false);
  assert.equal(isConversationVoiceMode({
    mode: "continue",
    conversationActive: false
  }), false);
});

test("empty transcripts reprompt only when audio likely contains speech", () => {
  assert.equal(shouldRepromptAfterEmptyTranscript({
    state: "idle",
    text: "",
    audio: { durationMs: 2000, rms: 900 }
  }), true);
  assert.equal(shouldRepromptAfterEmptyTranscript({
    state: "idle",
    text: "",
    audio: { durationMs: 2100, rms: 120 }
  }), false);
  assert.equal(shouldRepromptAfterEmptyTranscript({
    state: "idle",
    text: "继续",
    audio: { durationMs: 2100, rms: 900 }
  }), false);
  assert.equal(shouldRepromptAfterEmptyTranscript({
    state: "idle",
    text: "",
    audio: { durationMs: 2100, rms: 900 }
  }, { conversationActive: false }), false);
});

test("conversation continues after normal assistant replies but stops for agent commands", () => {
  assert.equal(shouldContinueConversation({
    state: "idle",
    text: "你在吗",
    preparedForAgent: false
  }), true);
  assert.equal(shouldContinueConversation({
    state: "ready",
    text: "帮我总结当前任务",
    preparedForAgent: true
  }), false);
  assert.equal(shouldContinueConversation({
    state: "idle",
    text: "退出对话",
    intent: { action: "exit_conversation" },
    preparedForAgent: false
  }), false);
});

test("assistant speech options resume listening only for conversational turns", () => {
  assert.deepEqual(speechOptionsForAssistantStatus({
    agent: "codex",
    state: "idle",
    text: "你在吗",
    preparedForAgent: false
  }), {
    agent: "codex",
    after: "listen"
  });
  assert.deepEqual(speechOptionsForAssistantStatus({
    agent: "claude",
    state: "ready",
    text: "帮我修复测试",
    preparedForAgent: true
  }), {
    agent: "claude",
    after: "idle"
  });
  assert.deepEqual(speechOptionsForAssistantStatus({
    agent: "codex",
    state: "idle",
    text: "退出对话",
    intent: { action: "exit_conversation" },
    preparedForAgent: false
  }), {
    agent: "codex",
    after: "idle"
  });
});

test("assistant processing decorates voice status as thinking with elapsed time", () => {
  assert.deepEqual(voiceStatusWithAssistantProcessing({
    state: "idle",
    agent: "codex",
    text: "你能做什么"
  }, {
    active: true,
    agent: "claude",
    startedAt: 1000,
    nowMs: 2450
  }), {
    state: "thinking",
    agent: "claude",
    text: "你能做什么",
    assistant: {
      elapsedMs: 1450
    }
  });

  assert.equal(voiceStatusWithAssistantProcessing({
    state: "recording",
    agent: "codex"
  }, {
    active: true,
    startedAt: 1000,
    nowMs: 2450
  }).state, "recording");
});

test("developer and analysis commands are still prepared for Codex or Claude Code", () => {
  assert.equal(shouldPrepareAgentCommand({ action: "develop" }), true);
  assert.equal(shouldPrepareAgentCommand({ action: "ask" }), true);
  assert.equal(shouldPrepareAgentCommand({ action: "agent" }), true);
  assert.equal(shouldPrepareAgentCommand({ action: "dictate" }), true);
  assert.equal(shouldPrepareAgentCommand({ action: "unknown" }), false);
});

test("focused dictation only captures unknown speech when a text input is focused", () => {
  assert.equal(shouldUseFocusedDictation({
    assistantEnabled: true,
    focusedTextInput: true,
    intent: { action: "unknown" }
  }), true);
  assert.equal(shouldUseFocusedDictation({
    assistantEnabled: true,
    focusedTextInput: true,
    intent: { action: "exit_conversation" }
  }), false);
  assert.equal(shouldUseFocusedDictation({
    assistantEnabled: true,
    focusedTextInput: false,
    intent: { action: "unknown" }
  }), false);
  assert.equal(shouldUseFocusedDictation({
    assistantEnabled: false,
    focusedTextInput: true,
    intent: { action: "unknown" }
  }), false);
});

test("focused dictation stays silent after pasting into the current input", () => {
  assert.equal(shouldSilenceFocusedDictation({
    state: "ready",
    preparedForAgent: true,
    intent: { action: "unknown" }
  }), true);
  assert.equal(shouldSilenceFocusedDictation({
    state: "ready",
    preparedForAgent: true,
    intent: { action: "develop" }
  }), false);
  assert.equal(shouldSilenceFocusedDictation({
    state: "idle",
    preparedForAgent: false,
    intent: { action: "unknown" }
  }), false);
});

test("active assistant conversations do not paste recognized turns until export", () => {
  assert.equal(shouldPasteRecognizedSpeech({
    assistantEnabled: true,
    focusedDictationEnabled: true,
    focusedTextInput: true,
    conversationActive: true,
    intent: { action: "unknown" }
  }), false);
  assert.equal(shouldPasteRecognizedSpeech({
    assistantEnabled: true,
    focusedDictationEnabled: true,
    focusedTextInput: true,
    conversationActive: true,
    intent: { action: "develop" }
  }), false);
  assert.equal(shouldPasteRecognizedSpeech({
    assistantEnabled: true,
    focusedDictationEnabled: true,
    focusedTextInput: true,
    conversationActive: false,
    intent: { action: "develop" }
  }), true);
  assert.equal(shouldPasteRecognizedSpeech({
    assistantEnabled: true,
    focusedDictationEnabled: true,
    focusedTextInput: true,
    conversationActive: false,
    intent: { action: "unknown" }
  }), true);
});

test("manual voice dictation stops after recognized text is pasted", () => {
  assert.equal(shouldResumeListeningAfterPreparedInput({
    state: "ready",
    text: "我要开发一个小游戏",
    preparedForAgent: true,
    intent: { action: "develop" }
  }, { conversationActive: true }), false);

  assert.equal(shouldResumeListeningAfterPreparedInput({
    state: "ready",
    text: "退下",
    preparedForAgent: false,
    intent: { action: "exit_conversation" }
  }, { conversationActive: true }), false);

  assert.equal(shouldResumeListeningAfterPreparedInput({
    state: "ready",
    text: "我要开发一个小游戏",
    preparedForAgent: true,
    intent: { action: "develop" }
  }, { conversationActive: false }), false);
});

test("exit conversation intent is recognized by session helpers", () => {
  assert.equal(shouldExitConversation({ action: "exit_conversation" }), true);
  assert.equal(shouldExitConversation({ action: "unknown" }), false);
});
