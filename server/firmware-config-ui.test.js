import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const firmwareSource = readFileSync(new URL("../firmware/src/main.cpp", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("firmware exposes a separate config screen without replacing dashboard mode", () => {
  assert.match(firmwareSource, /enum class UiMode/);
  assert.match(firmwareSource, /UiMode::Dashboard/);
  assert.match(firmwareSource, /UiMode::Config/);
  assert.match(firmwareSource, /drawConfigScreen/);
});

test("firmware provides Wi-Fi setup portal for scan, selection, password entry, and DHCP", () => {
  assert.match(firmwareSource, /#include <WiFiManager\.h>/);
  assert.match(firmwareSource, /startWiFiSetupPortal/);
  assert.match(firmwareSource, /BaizeWatch-Setup/);
  assert.match(firmwareSource, /startConfigPortal/);
  assert.match(firmwareSource, /WiFi\.localIP\(\)/);
});

test("firmware discovers the desktop monitor over LAN before using the fallback URL", () => {
  assert.match(firmwareSource, /#include <WiFiUdp\.h>/);
  assert.match(firmwareSource, /DISCOVERY_PORT = 8788/);
  assert.match(firmwareSource, /discoverMonitorWebSocketUrl/);
  assert.match(firmwareSource, /currentMonitorWsUrl/);
  assert.match(firmwareSource, /baize-watch-discover-v1/);
  assert.match(firmwareSource, /client\.connect\(currentMonitorWsUrl\)/);
  assert.doesNotMatch(firmwareSource, /client\.connect\(MONITOR_WS_URL\)/);
});

test("firmware supports on-device Wi-Fi scanning and password keyboard", () => {
  assert.match(firmwareSource, /UiMode::WifiList/);
  assert.match(firmwareSource, /UiMode::WifiKeyboard/);
  assert.match(firmwareSource, /scanWiFiNetworks/);
  assert.match(firmwareSource, /WiFi\.scanNetworks/);
  assert.match(firmwareSource, /KEYBOARD_CHARS/);
  assert.match(firmwareSource, /handleWifiKeyboardButtons/);
  assert.match(firmwareSource, /connectSelectedWiFi/);
});

test("firmware uses the Baize Watch touch screen for Wi-Fi selection and password entry", () => {
  assert.match(firmwareSource, /handleTouchInput/);
  assert.match(firmwareSource, /M5\.Touch\.getDetail\(\)/);
  assert.match(firmwareSource, /touch\.wasPressed\(\)/);
  assert.match(firmwareSource, /handleWifiListTouch/);
  assert.match(firmwareSource, /handleWifiKeyboardTouch/);
  assert.match(firmwareSource, /KEYBOARD_TOUCH_PADDING/);
  assert.match(firmwareSource, /drawKeyboardKey/);
});

test("password keyboard uses split pages, larger four-column keys, and a dedicated input panel", () => {
  assert.match(firmwareSource, /"abcdefghijklm"/);
  assert.match(firmwareSource, /"nopqrstuvwxyz"/);
  assert.match(firmwareSource, /"ABCDEFGHIJKLM"/);
  assert.match(firmwareSource, /"NOPQRSTUVWXYZ"/);
  assert.match(firmwareSource, /KEYBOARD_COLS = 4/);
  assert.match(firmwareSource, /KEYBOARD_KEY_WIDTH = 60/);
  assert.match(firmwareSource, /drawPasswordInputPanel/);
  assert.match(firmwareSource, /drawKeyboardActionBar/);
  assert.match(firmwareSource, /passwordInputText/);
});

test("password keyboard gives delete a second large touch target in the input panel", () => {
  assert.match(firmwareSource, /PASSWORD_DELETE_LEFT/);
  assert.match(firmwareSource, /PASSWORD_DELETE_WIDTH/);
  assert.match(firmwareSource, /handlePasswordDelete/);
  assert.match(firmwareSource, /drawPasswordDeleteButton/);
  assert.match(firmwareSource, /pointInRect\(x, y, PASSWORD_DELETE_LEFT/);
});

test("password delete button keeps its touch target without a visible frame", () => {
  const deleteButton = firmwareSource.match(/void drawPasswordDeleteButton\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(deleteButton, /drawString\("Del"/);
  assert.doesNotMatch(deleteButton, /fillRoundRect/);
  assert.doesNotMatch(deleteButton, /drawRoundRect/);
});

test("password input removes the PASS label and heavy background frame", () => {
  assert.doesNotMatch(firmwareSource, /drawString\("PASS"/);
  assert.doesNotMatch(firmwareSource, /fillRoundRect\(PASSWORD_PANEL_LEFT, PASSWORD_PANEL_TOP, PASSWORD_PANEL_WIDTH, PASSWORD_PANEL_HEIGHT/);
  assert.doesNotMatch(firmwareSource, /drawRoundRect\(PASSWORD_PANEL_LEFT, PASSWORD_PANEL_TOP, PASSWORD_PANEL_WIDTH, PASSWORD_PANEL_HEIGHT/);
  assert.match(firmwareSource, /drawPasswordDeleteButton/);
});

test("password keyboard keeps action controls inside the round screen safe area", () => {
  assert.match(firmwareSource, /KEYBOARD_TOP = 174/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_PAGE_LEFT = 72/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_PAGE_TOP = 118/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_PAGE_WIDTH = 80/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_PAGE_HEIGHT = 48/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_OK_LEFT = 382/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_OK_TOP = 202/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_OK_WIDTH = 44/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_OK_HEIGHT = 70/);
  assert.match(firmwareSource, /KEYBOARD_ACTION_TOUCH_PADDING = 8/);
  assert.match(firmwareSource, /KEYBOARD_STATUS_Y = 164/);
  assert.doesNotMatch(firmwareSource, /KEYBOARD_ACTION_DELETE_LEFT/);
  assert.doesNotMatch(firmwareSource, /KEYBOARD_ACTION_Y/);
  assert.doesNotMatch(firmwareSource, /fillRoundRect\(KEYBOARD_ACTION_/);
  assert.doesNotMatch(firmwareSource, /drawRoundRect\(KEYBOARD_ACTION_/);
  assert.doesNotMatch(firmwareSource, /drawString\(truncateText\(wifiSetupMessage, 28\), 233, 438\)/);
});

test("config screen entry avoids stealing active voice recording controls", () => {
  const handleButtons = firmwareSource.match(/void handleButtons\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(handleButtons, /voiceStatus\.state == "recording"/);
  assert.match(handleButtons, /stopVoiceRecording\(\)/);
  assert.match(handleButtons, /enterConfigScreen\(\)/);
  assert.ok(
    handleButtons.indexOf('voiceStatus.state == "recording"') < handleButtons.indexOf("enterConfigScreen()"),
    "recording stop path should run before config entry checks"
  );
});

test("voice controls ignore new wake requests while speaking or transcribing", () => {
  const handleButtons = firmwareSource.match(/void handleButtons\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(handleButtons, /voiceStatus\.state == "speaking" \|\| voiceStatus\.state == "transcribing" \|\| voiceStatus\.state == "thinking"/);
});

test("config screens keep content inside the round display without function background boxes", () => {
  const configScreen = firmwareSource.match(/void drawConfigScreen\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const wifiListScreen = firmwareSource.match(/void drawWifiListScreen\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const wifiKeyboardScreen = firmwareSource.match(/void drawWifiKeyboardScreen\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(firmwareSource, /CONFIG_MENU_COLS = 2/);
  assert.match(firmwareSource, /CONFIG_STATUS_LEFT = 92/);
  assert.match(firmwareSource, /CONFIG_STATUS_WIDTH = 282/);
  assert.match(firmwareSource, /CONFIG_MENU_LEFT = 88/);
  assert.match(firmwareSource, /CONFIG_MENU_TILE_WIDTH = 136/);
  assert.match(firmwareSource, /CONFIG_MESSAGE_Y = 398/);
  assert.match(firmwareSource, /WIFI_LIST_LEFT = 88/);
  assert.match(firmwareSource, /WIFI_LIST_WIDTH = 288/);
  assert.match(firmwareSource, /WIFI_LIST_MESSAGE_Y = 400/);
  assert.match(firmwareSource, /"Device WS", ConfigAction::ReconnectServer/);
  assert.match(firmwareSource, /drawConfigStatusRow\("Device WS", websocketConnected \? "connected" : "offline"/);
  assert.match(firmwareSource, /Device WS connected/);
  assert.match(firmwareSource, /Device WS offline/);
  assert.match(firmwareSource, /drawConfigStatusPanel/);
  assert.match(firmwareSource, /drawConfigStatusRow/);
  assert.match(firmwareSource, /drawConfigMenuTile/);
  assert.match(firmwareSource, /configMenuTileX/);
  assert.match(firmwareSource, /configMenuTileY/);
  assert.doesNotMatch(firmwareSource, /fillRoundRect\(CONFIG_STATUS_LEFT, CONFIG_STATUS_TOP, CONFIG_STATUS_WIDTH, CONFIG_STATUS_HEIGHT/);
  assert.doesNotMatch(firmwareSource, /drawRoundRect\(CONFIG_STATUS_LEFT, CONFIG_STATUS_TOP, CONFIG_STATUS_WIDTH, CONFIG_STATUS_HEIGHT/);
  assert.doesNotMatch(firmwareSource, /fillRoundRect\(x, y, CONFIG_MENU_TILE_WIDTH, CONFIG_MENU_TILE_HEIGHT/);
  assert.doesNotMatch(firmwareSource, /drawRoundRect\(x, y, CONFIG_MENU_TILE_WIDTH, CONFIG_MENU_TILE_HEIGHT/);
  assert.doesNotMatch(firmwareSource, /fillRoundRect\(WIFI_LIST_LEFT, top, WIFI_LIST_WIDTH, WIFI_LIST_ROW_HEIGHT/);
  assert.doesNotMatch(firmwareSource, /drawRoundRect\(WIFI_LIST_LEFT, top, WIFI_LIST_WIDTH, WIFI_LIST_ROW_HEIGHT/);
  assert.doesNotMatch(firmwareSource, /drawString\(truncateText\(configMessage, 28\), 233, 430\)/);
  assert.doesNotMatch(firmwareSource, /drawString\(truncateText\(wifiSetupMessage, 28\), 233, 424\)/);
  assert.doesNotMatch(configScreen, /drawArc/);
  assert.doesNotMatch(wifiListScreen, /drawArc/);
  assert.doesNotMatch(wifiKeyboardScreen, /drawArc/);
});

test("dashboard keeps content layout while turning outer arcs into a subtle voice status ring", () => {
  assert.match(firmwareSource, /drawAgentStateRing/);
  assert.match(firmwareSource, /drawSingleAgentDashboard\(const AgentStatus& agent, uint16_t accent, const uint16_t\* logo\)/);
  assert.match(firmwareSource, /drawAgentStateRing\(agent, accent\)/);
  assert.match(firmwareSource, /voiceStatus\.state == "recording"/);
  assert.match(firmwareSource, /voiceStatus\.state == "transcribing"/);
  assert.match(firmwareSource, /voiceStatus\.state == "thinking"/);
  assert.match(firmwareSource, /voiceStatus\.state == "error"/);
  assert.match(firmwareSource, /COLOR_RING_DIM/);
  assert.match(firmwareSource, /COLOR_YELLOW/);
  assert.match(firmwareSource, /COLOR_RED/);
  assert.doesNotMatch(firmwareSource, /Outer arcs mimic the reference face/);
  assert.doesNotMatch(firmwareSource, /drawArc\(233, 233, 206, 199, -215, -35, accent\)/);
});

test("dashboard shows assistant thinking progress while waiting for a reply", () => {
  assert.match(firmwareSource, /assistantThinkingStartedAt/);
  assert.match(firmwareSource, /voiceStatus\.assistantElapsedMs/);
  assert.match(firmwareSource, /drawString\("AI " \+ assistantLatencyText\(\), cx, cy \+ 42\)/);
  assert.match(firmwareSource, /voiceStatus\.state == "thinking" \? COLOR_VIOLET : COLOR_YELLOW/);
});

test("dashboard logo uses a nonzero animation offset instead of a static logo draw", () => {
  assert.match(firmwareSource, /animatedLogoBob/);
  assert.match(firmwareSource, /drawAnimatedLogo\(agent, logo, animatedLogoBob\(\)\)/);
  assert.match(firmwareSource, /LOGO_ANIMATION_MS/);
  assert.doesNotMatch(firmwareSource, /drawAnimatedLogo\(agent, logo, 0\)/);
});

test("firmware plays assistant TTS audio on the Baize Watch speaker", () => {
  assert.match(firmwareSource, /#include <mbedtls\/base64\.h>/);
  assert.match(firmwareSource, /handleTtsStart/);
  assert.match(firmwareSource, /handleTtsAudio/);
  assert.match(firmwareSource, /handleTtsDone/);
  assert.match(firmwareSource, /mbedtls_base64_decode/);
  assert.match(firmwareSource, /M5\.Mic\.end\(\)/);
  assert.match(firmwareSource, /M5\.Speaker\.begin\(\)/);
  assert.match(firmwareSource, /TTS_SPEAKER_VOLUME = 255/);
  assert.match(firmwareSource, /M5\.Speaker\.playRaw/);
  assert.match(firmwareSource, /waitForTtsPlaybackStart/);
  assert.match(firmwareSource, /M5\.Speaker\.end\(\)/);
  assert.match(firmwareSource, /type == "tts_start"/);
  assert.match(firmwareSource, /type == "tts_audio"/);
  assert.match(firmwareSource, /type == "tts_done"/);
});

test("firmware resumes listening after assistant wake or conversational speech", () => {
  assert.match(firmwareSource, /voice_wake/);
  assert.match(firmwareSource, /wakeVoiceAssistant/);
  assert.match(firmwareSource, /playWakeCue/);
  assert.match(firmwareSource, /deviceWakeCue/);
  assert.match(firmwareSource, /voiceStatus\.deviceWakeCue/);
  assert.match(firmwareSource, /startVoiceRecording\(agentIndex, false, "continue"\)/);
  assert.match(firmwareSource, /ttsAfterAction/);
  assert.match(firmwareSource, /ttsAfterAction == "listen"/);
  assert.match(firmwareSource, /startVoiceRecording\(agentIndexForKey\(ttsAfterAgent\), false, "continue"\)/);
  assert.match(firmwareSource, /void startVoiceRecording\(int agentIndex, bool announce, const char\* mode/);
  assert.match(firmwareSource, /waking \|\| voiceStatus\.state == "recording"/);
});

test("firmware uses left short press for transcription, right hold for cancel, and right press to send", () => {
  const handleButtons = firmwareSource.match(/void handleButtons\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(firmwareSource, /voiceSessionActive/);
  assert.match(
    handleButtons,
    /if \(voiceStatus\.state == "recording"\) \{\s*if \(leftPressed && voiceSessionActive && !voiceSawSpeech\) \{\s*exportVoiceConversation\(\);\s*return;\s*\}\s*if \(leftPressed\) \{\s*stopVoiceRecording\(\);\s*return;\s*\}\s*if \(rightHeld \|\| leftReleasedAfterHold\) \{\s*exitVoiceSession\(\);\s*return;\s*\}\s*return;\s*\}/
  );
  assert.doesNotMatch(handleButtons, /if \(leftReleased\) \{\s*stopVoiceRecording\(\);/);
  assert.match(handleButtons, /rightPressed && voiceStatus\.state == "ready"/);
  assert.match(firmwareSource, /voice_exit/);
  assert.match(firmwareSource, /void exportVoiceConversation\(\)/);
});

test("ready transcript send does not block double-right unified wake", () => {
  const handleButtons = firmwareSource.match(/void handleButtons\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(firmwareSource, /voiceSendPending/);
  assert.match(firmwareSource, /handlePendingVoiceSend/);
  assert.match(handleButtons, /scheduleVoiceSend\(\)/);
  assert.match(handleButtons, /cancelPendingVoiceSend\(\)/);
  assert.match(handleButtons, /wakeVoiceAssistant\(activeAgentIndex\)/);
  assert.ok(
    handleButtons.indexOf("cancelPendingVoiceSend()") < handleButtons.indexOf("wakeVoiceAssistant(activeAgentIndex)"),
    "double-right should cancel pending send before unified wake"
  );
  assert.doesNotMatch(handleButtons, /buttonIndex == 0 \? activeAgentIndex : 1/);
});

test("dashboard left single cycles agents and left double starts dictation without conflict", () => {
  const handleButtons = firmwareSource.match(/void handleButtons\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(firmwareSource, /void toggleActiveAgent\(\)/);
  assert.match(firmwareSource, /activeAgentIndex = activeAgentIndex == 0 \? 1 : 0/);
  assert.match(firmwareSource, /void scheduleAgentSwitch\(\)/);
  assert.match(firmwareSource, /void handlePendingAgentSwitch\(\)/);
  assert.match(handleButtons, /if \(leftPressed\) \{\s*scheduleAgentSwitch\(\);\s*return;\s*\}/);
  assert.match(handleButtons, /if \(!leftPressed && !rightPressed\) \{\s*return;\s*\}/);
  assert.ok(
    handleButtons.indexOf("if (!leftPressed && !rightPressed)") < handleButtons.indexOf("const int buttonIndex"),
    "release-only events should not cancel pending left-button agent switches"
  );
  assert.match(handleButtons, /if \(buttonIndex == 0\) \{\s*needsFullRedraw = true;\s*startVoiceRecording\(activeAgentIndex, false, "dictate"\);\s*return;\s*\}/);
  assert.doesNotMatch(handleButtons, /if \(rightPressed && voiceStatus\.state == "idle"\)/);
  assert.match(handleButtons, /wakeVoiceAssistant\(activeAgentIndex\)/);
  assert.doesNotMatch(handleButtons, /activeAgentIndex = buttonIndex;\s*needsFullRedraw = true;\s*lastVoiceButtonIndex = buttonIndex;/);
});

test("firmware displays ASR latency while transcribing and after status updates", () => {
  assert.match(firmwareSource, /asrLatencyMs/);
  assert.match(firmwareSource, /asrTranscribingStartedAt/);
  assert.match(firmwareSource, /source\["asr"\]\["latencyMs"\]/);
  assert.match(firmwareSource, /voiceLatencyText/);
  assert.match(firmwareSource, /drawString\("ASR " \+ voiceLatencyText\(\), cx, cy \+ 42\)/);
  assert.match(firmwareSource, /voiceStatus\.state == "transcribing" && voiceStatus\.asrTranscribingStartedAt > 0/);
});

test("firmware no longer uses the old short-pause dictation timeout constants", () => {
  assert.doesNotMatch(firmwareSource, /VOICE_SILENCE_STOP_MS/);
  assert.doesNotMatch(firmwareSource, /VOICE_NO_SPEECH_STOP_MS/);
  assert.match(firmwareSource, /VOICE_SPEECH_RMS_THRESHOLD/);
  assert.match(firmwareSource, /voiceSawSpeech/);
  assert.match(firmwareSource, /lastVoiceSpeechAt/);
  assert.match(firmwareSource, /voiceChunkRms/);
  assert.doesNotMatch(firmwareSource, /VOICE_NO_SPEECH_STOP_MS/);
});

test("firmware auto-finalizes conversation turns and exports the session from idle listening", () => {
  const handleButtons = firmwareSource.match(/void handleButtons\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const handleRecording = firmwareSource.match(/void handleVoiceRecording\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(firmwareSource, /VOICE_DICTATION_SILENCE_STOP_MS = 1800/);
  assert.match(firmwareSource, /VOICE_CONVERSATION_SILENCE_STOP_MS = 1000/);
  assert.match(firmwareSource, /VOICE_CONVERSATION_SILENCE_STOP_MS/);
  assert.match(firmwareSource, /void exportVoiceConversation\(\)/);
  assert.match(firmwareSource, /voice_export/);
  assert.match(handleButtons, /if \(leftPressed && voiceSessionActive && !voiceSawSpeech\) \{\s*exportVoiceConversation\(\);\s*return;\s*\}/);
  assert.match(handleRecording, /voiceConversationMode\s*\?\s*VOICE_CONVERSATION_SILENCE_STOP_MS\s*:\s*VOICE_DICTATION_SILENCE_STOP_MS/);
  assert.match(handleRecording, /voiceSawSpeech && millis\(\) - lastVoiceSpeechAt > silenceStopMs/);
});

test("README documents config screen controls", () => {
  assert.match(readme, /Configuration Screen/);
  assert.match(readme, /Long-press either programmable button/);
  assert.match(readme, /Left button moves selection/);
  assert.match(readme, /Right button runs the selected action/);
  assert.match(readme, /BaizeWatch-Setup/);
  assert.match(readme, /select a scanned Wi-Fi network/);
  assert.match(readme, /enter the password/);
  assert.match(readme, /on-device Wi-Fi setup/);
  assert.match(readme, /Left button cycles/);
  assert.match(readme, /Long-press right connects/);
  assert.match(readme, /Tap a Wi-Fi name/);
  assert.match(readme, /Tap keyboard characters/);
  assert.match(readme, /Device WS reconnect/);
  assert.match(readme, /Device WebSocket connection state/);
});
