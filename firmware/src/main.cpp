#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <M5Unified.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiUdp.h>
#include <math.h>
#include <mbedtls/base64.h>
#include "agent_logos.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MONITOR_WS_URL "ws://192.168.1.10:8787/device"
#endif

using namespace websockets;

constexpr size_t MAX_TREND_POINTS = 12;

struct MonitorStatus {
  String label = "Baize Watch";
  String time = "--";
  String gitBranch = "--";
  int cpu = 0;
  int mem = 0;
  int battery = -1;
  int gitChanged = -1;
  bool charging = false;
  String alerts = "";
};

struct AgentStatus {
  String name = "--";
  bool online = false;
  String state = "offline";
  String task = "";
  int tokenPercent = -1;
  int progress = -1;
  String primaryUsageLabel = "usage";
  int primaryUsagePercent = -1;
  String primaryUsageReset = "--";
  String secondaryUsageLabel = "weekly";
  int secondaryUsagePercent = -1;
  String secondaryUsageReset = "--";
  bool hasUsageWindows = false;
  uint64_t usageTotal = 0;
  bool hasUsageTotal = false;
  uint64_t weeklyTotal = 0;
  bool hasWeeklyTotal = false;
  uint64_t usageTrend[MAX_TREND_POINTS] = {};
  size_t usageTrendCount = 0;
  uint64_t weeklyTrend[MAX_TREND_POINTS] = {};
  size_t weeklyTrendCount = 0;

  AgentStatus() = default;
  explicit AgentStatus(const String& agentName) : name(agentName) {}
};

struct VoiceStatus {
  String state = "idle";
  String agent = "codex";
  String text = "";
  String error = "";
  bool deviceWakeCue = false;
  uint32_t asrLatencyMs = 0;
  bool hasAsrLatency = false;
  unsigned long asrTranscribingStartedAt = 0;
  uint32_t assistantElapsedMs = 0;
  bool hasAssistantElapsed = false;
  unsigned long assistantThinkingStartedAt = 0;
};

enum class UiMode {
  Dashboard,
  Config,
  WifiList,
  WifiKeyboard
};

enum class ConfigAction {
  ReconnectServer,
  WifiSetup,
  WifiPortal,
  Exit
};

struct ConfigMenuItem {
  const char* label;
  ConfigAction action;
};

WebsocketsClient client;
WiFiUDP discoveryUdp;
MonitorStatus status;
AgentStatus codex("Codex");
AgentStatus claude("Claude Code");
VoiceStatus voiceStatus;

bool websocketConnected = false;
int activeAgentIndex = 0;
UiMode uiMode = UiMode::Dashboard;
size_t selectedConfigItem = 0;
String configMessage = "Ready";
String wifiSetupMessage = "Select Wi-Fi";
static constexpr size_t MAX_WIFI_NETWORKS = 8;
static constexpr size_t MAX_WIFI_PASSWORD_LENGTH = 64;
String wifiSsids[MAX_WIFI_NETWORKS];
int32_t wifiRssi[MAX_WIFI_NETWORKS] = {};
size_t wifiNetworkCount = 0;
size_t selectedWifiIndex = 0;
String selectedWifiSsid = "";
String typedWifiPassword = "";
size_t keyboardIndex = 0;
size_t keyboardPage = 0;
unsigned long lastConnectAttempt = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastVoiceButtonPress = 0;
unsigned long lastVoiceAnimationFrame = 0;
unsigned long lastDashboardAnimationFrame = 0;
unsigned long voiceRecordingStartedAt = 0;
unsigned long lastVoiceSpeechAt = 0;
int lastVoiceButtonIndex = -1;
unsigned long lastTouchHandled = 0;
bool voiceSawSpeech = false;
bool needsFullRedraw = true;
bool voiceSessionActive = false;
bool voiceConversationMode = false;
bool voiceSendPending = false;
unsigned long voiceSendPendingAt = 0;
bool agentSwitchPending = false;
unsigned long agentSwitchPendingAt = 0;
String currentMonitorWsUrl = MONITOR_WS_URL;

constexpr uint16_t COLOR_BG = 0x0841;
constexpr uint16_t COLOR_PANEL = 0x18E3;
constexpr uint16_t COLOR_TEXT = 0xFFFF;
constexpr uint16_t COLOR_MUTED = 0x9CF3;
constexpr uint16_t COLOR_GREEN = 0x4ECA;
constexpr uint16_t COLOR_YELLOW = 0xFEA0;
constexpr uint16_t COLOR_RED = 0xF986;
constexpr uint16_t COLOR_BLUE = 0x45BF;
constexpr uint16_t COLOR_CYAN = 0x5FFF;
constexpr uint16_t COLOR_VIOLET = 0x8A9F;
constexpr uint16_t COLOR_RING_DIM = 0x2104;
constexpr uint16_t COLOR_RING_TRACK = 0x39E7;
constexpr uint32_t VOICE_SAMPLE_RATE = 16000;
constexpr size_t VOICE_CHUNK_SAMPLES = 320;
constexpr uint32_t TTS_SAMPLE_RATE_DEFAULT = 16000;
constexpr size_t TTS_AUDIO_BUFFER_SAMPLES = 2048;
constexpr uint8_t TTS_SPEAKER_VOLUME = 255;
constexpr int TTS_SPEAKER_CHANNEL = 0;
constexpr uint32_t WAKE_CUE_SAMPLE_RATE = 16000;
constexpr size_t WAKE_CUE_SAMPLES = 960;
constexpr int16_t WAKE_CUE_AMPLITUDE = 7600;
constexpr unsigned long VOICE_DOUBLE_PRESS_MS = 450;
constexpr unsigned long VOICE_MAX_RECORDING_MS = 120000;
constexpr unsigned long VOICE_DICTATION_SILENCE_STOP_MS = 1800;
constexpr unsigned long VOICE_CONVERSATION_SILENCE_STOP_MS = 1000;
constexpr int32_t VOICE_SPEECH_RMS_THRESHOLD = 420;
constexpr unsigned long VOICE_ANIMATION_MS = 140;
constexpr unsigned long DASHBOARD_ANIMATION_MS = 360;
constexpr unsigned long LOGO_ANIMATION_MS = 180;
constexpr uint16_t DISCOVERY_PORT = 8788;
constexpr unsigned long DISCOVERY_TIMEOUT_MS = 1400;
constexpr const char* DISCOVERY_REQUEST = "baize-watch-discover-v1";
constexpr const char* KEYBOARD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.@#$%&*!?+/";
constexpr const char* KEYBOARD_PAGES[] = {
  "abcdefghijklm",
  "nopqrstuvwxyz",
  "ABCDEFGHIJKLM",
  "NOPQRSTUVWXYZ",
  "0123456789",
  "-_.@#$%&*!?+/"
};
constexpr const char* KEYBOARD_PAGE_LABELS[] = {"a-m", "n-z", "A-M", "N-Z", "123", "#+="};
constexpr size_t KEYBOARD_PAGE_COUNT = sizeof(KEYBOARD_PAGES) / sizeof(KEYBOARD_PAGES[0]);
constexpr int32_t WIFI_LIST_LEFT = 88;
constexpr int32_t WIFI_LIST_TOP = 151;
constexpr int32_t WIFI_LIST_WIDTH = 288;
constexpr int32_t WIFI_LIST_ROW_HEIGHT = 34;
constexpr int32_t WIFI_LIST_ROW_GAP = 8;
constexpr int32_t KEYBOARD_COLS = 4;
constexpr int32_t KEYBOARD_LEFT = 95;
constexpr int32_t KEYBOARD_TOP = 174;
constexpr int32_t KEYBOARD_KEY_WIDTH = 60;
constexpr int32_t KEYBOARD_KEY_HEIGHT = 38;
constexpr int32_t KEYBOARD_KEY_GAP = 10;
constexpr int32_t KEYBOARD_TOUCH_PADDING = 8;
constexpr int32_t KEYBOARD_ACTION_PAGE_LEFT = 72;
constexpr int32_t KEYBOARD_ACTION_PAGE_TOP = 118;
constexpr int32_t KEYBOARD_ACTION_PAGE_WIDTH = 80;
constexpr int32_t KEYBOARD_ACTION_PAGE_HEIGHT = 48;
constexpr int32_t KEYBOARD_ACTION_OK_LEFT = 382;
constexpr int32_t KEYBOARD_ACTION_OK_TOP = 202;
constexpr int32_t KEYBOARD_ACTION_OK_WIDTH = 44;
constexpr int32_t KEYBOARD_ACTION_OK_HEIGHT = 70;
constexpr int32_t KEYBOARD_ACTION_TOUCH_PADDING = 8;
constexpr int32_t KEYBOARD_STATUS_Y = 164;
constexpr int32_t PASSWORD_PANEL_LEFT = 72;
constexpr int32_t PASSWORD_PANEL_TOP = 104;
constexpr int32_t PASSWORD_PANEL_WIDTH = 322;
constexpr int32_t PASSWORD_PANEL_HEIGHT = 58;
constexpr int32_t PASSWORD_DELETE_LEFT = PASSWORD_PANEL_LEFT + PASSWORD_PANEL_WIDTH - 82;
constexpr int32_t PASSWORD_DELETE_TOP = PASSWORD_PANEL_TOP + 8;
constexpr int32_t PASSWORD_DELETE_WIDTH = 70;
constexpr int32_t PASSWORD_DELETE_HEIGHT = 42;
constexpr int32_t CONFIG_STATUS_LEFT = 92;
constexpr int32_t CONFIG_STATUS_TOP = 118;
constexpr int32_t CONFIG_STATUS_WIDTH = 282;
constexpr int32_t CONFIG_STATUS_HEIGHT = 108;
constexpr int32_t CONFIG_MENU_COLS = 2;
constexpr int32_t CONFIG_MENU_LEFT = 88;
constexpr int32_t CONFIG_MENU_TOP = 250;
constexpr int32_t CONFIG_MENU_WIDTH = 288;
constexpr int32_t CONFIG_MENU_TILE_WIDTH = 136;
constexpr int32_t CONFIG_MENU_TILE_HEIGHT = 48;
constexpr int32_t CONFIG_MENU_GAP_X = 22;
constexpr int32_t CONFIG_MENU_GAP_Y = 14;
constexpr int32_t CONFIG_MESSAGE_Y = 398;
constexpr int32_t WIFI_LIST_MESSAGE_Y = 400;

const ConfigMenuItem CONFIG_MENU[] = {
  {"Device WS", ConfigAction::ReconnectServer},
  {"Wi-Fi setup", ConfigAction::WifiSetup},
  {"Wi-Fi portal", ConfigAction::WifiPortal},
  {"Exit config", ConfigAction::Exit}
};
constexpr size_t CONFIG_MENU_COUNT = sizeof(CONFIG_MENU) / sizeof(CONFIG_MENU[0]);

M5Canvas screenCanvas(&M5.Display);
LovyanGFX* drawTarget = &M5.Display;
bool screenCanvasReady = false;
int16_t voiceAudioBuffer[VOICE_CHUNK_SAMPLES];
int16_t ttsAudioBuffer[TTS_AUDIO_BUFFER_SAMPLES];
int16_t wakeCueBuffer[WAKE_CUE_SAMPLES];
uint32_t ttsSampleRate = TTS_SAMPLE_RATE_DEFAULT;
bool ttsPlaybackActive = false;
String ttsAfterAction = "";
String ttsAfterAgent = "codex";

void connectWiFi();
bool connectStoredWiFi(unsigned long timeoutMs);
bool connectStaticWiFi(unsigned long timeoutMs);
bool waitForWiFi(unsigned long timeoutMs, const String& label);
bool startWiFiSetupPortal();
void beginOnDeviceWiFiSetup();
void scanWiFiNetworks();
bool isKnownWifiSsid(const String& ssid, size_t count);
void connectSelectedWiFi();
void connectWebSocket();
String discoverMonitorWebSocketUrl(unsigned long timeoutMs = DISCOVERY_TIMEOUT_MS);
void drawBootScreen(const String& line);
void drawStatus();
void drawMetricArc(int32_t x, int32_t y, int32_t r, int value, uint16_t color, const String& label);
void drawAgentColumn(int32_t centerX, const AgentStatus& agent, uint16_t accent);
void drawSingleAgentDashboard(const AgentStatus& agent, uint16_t accent, const uint16_t* logo);
void drawAgentStateRing(const AgentStatus& agent, uint16_t accent);
bool isVoiceStateForAgent(const AgentStatus& agent);
int animatedLogoBob();
void drawAnimatedLogo(const AgentStatus& agent, const uint16_t* logo, int bob);
void pushRgb565Image(int32_t x, int32_t y, int32_t w, int32_t h, const uint16_t* image);
void drawTransparentRgb565Image(int32_t x, int32_t y, int32_t w, int32_t h, const uint16_t* image, uint16_t transparent);
bool isTransparentLogoPixel(uint16_t color, uint16_t transparent);
void drawUsageRow(int32_t y, const String& label, int percent, const String& timeText, uint16_t accent);
void drawSegmentBar(int32_t x, int32_t y, int percent, uint16_t accent);
void drawUsageBars(const AgentStatus& agent, uint16_t accent);
void drawTokenUsageBars(const AgentStatus& agent, uint16_t accent);
void drawVerticalUsageBar(int32_t centerX, int32_t topY, const String& label, int percent, const String& timeText, uint16_t accent);
void drawUsageTrends(const AgentStatus& agent, uint16_t accent);
void drawTokenTrendChart(int32_t centerX, int32_t topY, const String& label, uint64_t total, bool hasTotal, const uint64_t* points, size_t count, uint16_t color);
void drawUsageWindowFooter(const AgentStatus& agent, uint16_t accent);
void drawUsageWindowFooterItem(int32_t y, const String& label, int percent, const String& resetText, uint16_t color);
void drawVoiceIndicator(uint16_t accent);
void drawMicGlyph(int32_t centerX, int32_t centerY, uint16_t color);
void drawCheckGlyph(int32_t centerX, int32_t centerY, uint16_t color);
String voiceLatencyText();
String assistantLatencyText();
void handleButtons();
void handleTouchInput();
void handleConfigButtons(bool leftPressed, bool rightPressed, bool held);
void handleWifiListButtons(bool leftPressed, bool rightPressed, bool held);
void handleWifiKeyboardButtons(bool leftPressed, bool rightPressed, bool leftHeld, bool rightHeld);
void handleConfigTouch(int32_t x, int32_t y);
void handleWifiListTouch(int32_t x, int32_t y);
void handleWifiKeyboardTouch(int32_t x, int32_t y);
void handlePasswordDelete();
void appendKeyboardChar(char c);
void switchKeyboardPage();
void enterConfigScreen();
void exitConfigScreen();
void performConfigAction(ConfigAction action);
void drawConfigScreen();
void drawConfigValue(const String& label, const String& value, int32_t y, uint16_t valueColor = COLOR_TEXT);
void drawConfigMenuRow(size_t index, int32_t y);
void drawConfigStatusPanel();
void drawConfigStatusRow(const String& label, const String& value, int32_t y, uint16_t valueColor = COLOR_TEXT);
void drawConfigMenuTile(size_t index);
int32_t configMenuTileX(size_t index);
int32_t configMenuTileY(size_t index);
void drawWifiListScreen();
void drawWifiKeyboardScreen();
void drawPasswordInputPanel();
void drawPasswordDeleteButton();
void drawKeyboardActionBar();
void drawKeyboardKey(size_t index, int32_t x, int32_t y, int32_t w, int32_t h);
String maskedWifiPassword();
String passwordInputText();
char currentKeyboardChar();
const char* currentKeyboardPage();
size_t currentKeyboardPageLength();
int keyboardKeyAt(int32_t x, int32_t y);
bool pointInRect(int32_t px, int32_t py, int32_t x, int32_t y, int32_t w, int32_t h);
bool isWiFiSetupMode();
void handleVoiceRecording();
uint32_t voiceChunkRms(const int16_t* samples, size_t count);
void wakeVoiceAssistant(int agentIndex);
void exitVoiceSession();
void playWakeCue();
void startVoiceRecording(int agentIndex, bool announce, const char* mode = "continue");
void stopVoiceRecording();
void exportVoiceConversation();
void sendVoiceTranscript();
void scheduleVoiceSend();
void cancelPendingVoiceSend();
void handlePendingVoiceSend();
void scheduleAgentSwitch();
void cancelPendingAgentSwitch();
void handlePendingAgentSwitch();
void toggleActiveAgent();
void drawCenteredText(const String& text, int32_t y, const lgfx::IFont* font, uint16_t color);
void handleMessage(WebsocketsMessage message);
void handleEvent(WebsocketsEvent event, String data);
void parseStatus(JsonDocument& doc);
void handleVoiceContinue(JsonVariant source);
void handleTtsStart(JsonVariant source);
void handleTtsAudio(JsonVariant source);
void handleTtsDone();
size_t decodeTtsAudio(const String& encoded);
void waitForTtsPlaybackSlot();
bool waitForTtsPlaybackStart(unsigned long timeoutMs = 80);
void parseAgent(JsonVariant source, AgentStatus& target, const String& fallbackName);
void resetAgentMetrics(AgentStatus& target);
void parseTrend(JsonVariant source, uint64_t& total, bool& hasTotal, uint64_t* points, size_t& count);
void parseVoice(JsonVariant source);
String shortTime(const String& isoTime);
String compactBytes(int percent);
String percentText(int value);
String truncateText(const String& text, size_t maxLength);
String durationText(int percent);
String compactTokenCount(uint64_t value, bool available);
uint16_t colorForPercent(int value);
const AgentStatus& activeAgent();
String agentKey(int agentIndex);
int agentIndexForKey(const String& agent);

void setup() {
  auto config = M5.config();
  config.serial_baudrate = 115200;
  M5.begin(config);
  M5.Display.setRotation(0);
  M5.Display.setBrightness(255);
  M5.Display.fillScreen(COLOR_BG);
  drawTarget = &M5.Display;
  screenCanvas.setColorDepth(16);
  screenCanvasReady = screenCanvas.createSprite(M5.Display.width(), M5.Display.height()) != nullptr;
  if (screenCanvasReady) {
    screenCanvas.fillSprite(COLOR_BG);
  }

  Serial.begin(115200);
  delay(200);

  client.onMessage(handleMessage);
  client.onEvent(handleEvent);

  drawBootScreen("Wi-Fi");
  connectWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    drawBootScreen("WebSocket");
    connectWebSocket();
  }
}

void loop() {
  M5.update();

  if (WiFi.status() != WL_CONNECTED && !isWiFiSetupMode()) {
    websocketConnected = false;
    connectWiFi();
  }

  if (WiFi.status() == WL_CONNECTED && !websocketConnected && millis() - lastConnectAttempt > 3000) {
    connectWebSocket();
  }

  client.poll();

  handlePendingVoiceSend();
  handlePendingAgentSwitch();
  handleButtons();
  handleTouchInput();
  handleVoiceRecording();

  if (voiceStatus.state != "idle" && millis() - lastVoiceAnimationFrame > VOICE_ANIMATION_MS) {
    lastVoiceAnimationFrame = millis();
    needsFullRedraw = true;
  }

  if (millis() - lastDashboardAnimationFrame > DASHBOARD_ANIMATION_MS) {
    lastDashboardAnimationFrame = millis();
    needsFullRedraw = true;
  }

  if (websocketConnected && millis() - lastHeartbeat > 10000) {
    client.send("{\"type\":\"heartbeat\",\"device\":\"baize-watch\"}");
    lastHeartbeat = millis();
  }

  if (needsFullRedraw) {
    drawStatus();
    needsFullRedraw = false;
  }
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(true);

  if (connectStoredWiFi(8000)) {
    return;
  }

  if (connectStaticWiFi(10000)) {
    return;
  }

  beginOnDeviceWiFiSetup();
}

bool connectStoredWiFi(unsigned long timeoutMs) {
  drawBootScreen("Saved Wi-Fi");
  WiFi.begin();
  if (!waitForWiFi(timeoutMs, "Saved")) {
    return false;
  }

  Serial.print("Wi-Fi connected from saved config: ");
  Serial.println(WiFi.localIP());
  return true;
}

bool connectStaticWiFi(unsigned long timeoutMs) {
  if (String(WIFI_SSID) == "YOUR_WIFI_SSID") {
    return false;
  }

  drawBootScreen("Static Wi-Fi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  if (!waitForWiFi(timeoutMs, "Static")) {
    return false;
  }

  Serial.print("Wi-Fi connected from firmware config: ");
  Serial.println(WiFi.localIP());
  return true;
}

bool waitForWiFi(unsigned long timeoutMs, const String& label) {
  const unsigned long startedAt = millis();
  uint8_t dot = 0;
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < timeoutMs) {
    drawBootScreen(label + " " + String(dot % 4, DEC));
    dot++;
    delay(450);
  }

  return WiFi.status() == WL_CONNECTED;
}

bool startWiFiSetupPortal() {
  drawBootScreen("Wi-Fi setup");
  drawCenteredText("Join BaizeWatch-Setup", 306, &fonts::Font2, COLOR_TEXT);
  drawCenteredText("Open 192.168.4.1", 330, &fonts::Font2, COLOR_MUTED);

  WiFiManager wifiManager;
  wifiManager.setDebugOutput(false);
  wifiManager.setConfigPortalTimeout(300);
  wifiManager.setConnectTimeout(20);

  Serial.println("Starting Wi-Fi setup portal: BaizeWatch-Setup");
  const bool connected = wifiManager.startConfigPortal("BaizeWatch-Setup");
  if (!connected) {
    drawBootScreen("Wi-Fi failed");
    Serial.println("Wi-Fi setup portal timed out or failed.");
    delay(1200);
    return false;
  }

  drawBootScreen("Wi-Fi ready");
  Serial.print("Wi-Fi setup connected: ");
  Serial.println(WiFi.localIP());
  delay(800);
  return true;
}

void beginOnDeviceWiFiSetup() {
  websocketConnected = false;
  client.close();
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false);
  delay(100);

  scanWiFiNetworks();
  uiMode = UiMode::WifiList;
  selectedWifiIndex = 0;
  wifiSetupMessage = wifiNetworkCount > 0 ? "Select Wi-Fi" : "No networks";
  needsFullRedraw = true;
}

void scanWiFiNetworks() {
  drawBootScreen("Scanning Wi-Fi");
  wifiNetworkCount = 0;
  selectedWifiIndex = 0;

  const int networkCount = WiFi.scanNetworks();
  if (networkCount <= 0) {
    WiFi.scanDelete();
    return;
  }

  for (int i = 0; i < networkCount && wifiNetworkCount < MAX_WIFI_NETWORKS; i++) {
    const String ssid = WiFi.SSID(i);
    if (ssid.length() == 0 || isKnownWifiSsid(ssid, wifiNetworkCount)) {
      continue;
    }
    wifiSsids[wifiNetworkCount] = ssid;
    wifiRssi[wifiNetworkCount] = WiFi.RSSI(i);
    wifiNetworkCount++;
  }
  WiFi.scanDelete();
}

bool isKnownWifiSsid(const String& ssid, size_t count) {
  for (size_t i = 0; i < count; i++) {
    if (wifiSsids[i] == ssid) return true;
  }
  return false;
}

void connectSelectedWiFi() {
  if (selectedWifiSsid.length() == 0) {
    wifiSetupMessage = "No Wi-Fi selected";
    needsFullRedraw = true;
    return;
  }

  drawBootScreen("Connecting Wi-Fi");
  drawCenteredText(truncateText(selectedWifiSsid, 18), 306, &fonts::Font2, COLOR_TEXT);

  WiFi.mode(WIFI_STA);
  WiFi.persistent(true);
  WiFi.begin(selectedWifiSsid.c_str(), typedWifiPassword.c_str());

  if (!waitForWiFi(20000, "Wi-Fi")) {
    uiMode = UiMode::WifiKeyboard;
    wifiSetupMessage = "Connect failed";
    needsFullRedraw = true;
    return;
  }

  websocketConnected = false;
  connectWebSocket();
  uiMode = UiMode::Config;
  configMessage = "Wi-Fi ready";
  wifiSetupMessage = "Connected";
  needsFullRedraw = true;
}

void connectWebSocket() {
  lastConnectAttempt = millis();
  drawBootScreen("Finding server");
  String discoveredUrl = discoverMonitorWebSocketUrl();
  if (discoveredUrl.length() > 0) {
    currentMonitorWsUrl = discoveredUrl;
  } else if (currentMonitorWsUrl.length() == 0) {
    currentMonitorWsUrl = MONITOR_WS_URL;
  }

  drawBootScreen("Connecting");
  Serial.print("Connecting to ");
  Serial.println(currentMonitorWsUrl);

  websocketConnected = client.connect(currentMonitorWsUrl);
  if (!websocketConnected && currentMonitorWsUrl != String(MONITOR_WS_URL)) {
    Serial.println("Discovered WebSocket failed; trying firmware fallback.");
    currentMonitorWsUrl = MONITOR_WS_URL;
    Serial.print("Connecting to ");
    Serial.println(currentMonitorWsUrl);
    websocketConnected = client.connect(currentMonitorWsUrl);
  }

  if (!websocketConnected) {
    drawBootScreen("No server");
    Serial.println("WebSocket connection failed.");
    return;
  }

  client.send("{\"type\":\"hello\",\"device\":\"baize-watch\"}");
  Serial.println("WebSocket connected.");
  needsFullRedraw = true;
}

String discoverMonitorWebSocketUrl(unsigned long timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) {
    return "";
  }

  if (!discoveryUdp.begin(0)) {
    Serial.println("Discovery UDP bind failed.");
    return "";
  }

  discoveryUdp.beginPacket(IPAddress(255, 255, 255, 255), DISCOVERY_PORT);
  discoveryUdp.write(reinterpret_cast<const uint8_t*>(DISCOVERY_REQUEST), strlen(DISCOVERY_REQUEST));
  discoveryUdp.endPacket();

  const unsigned long startedAt = millis();
  while (millis() - startedAt < timeoutMs) {
    const int packetSize = discoveryUdp.parsePacket();
    if (packetSize <= 0) {
      delay(20);
      continue;
    }

    char buffer[256];
    const int length = discoveryUdp.read(buffer, min(packetSize, int(sizeof(buffer) - 1)));
    if (length <= 0) {
      continue;
    }
    buffer[length] = '\0';

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, buffer);
    if (error) {
      continue;
    }

    const String type = doc["type"] | "";
    const String wsUrl = doc["wsUrl"] | "";
    if (type == "baize_watch" && wsUrl.startsWith("ws://")) {
      discoveryUdp.stop();
      Serial.print("Discovered monitor: ");
      Serial.println(wsUrl);
      return wsUrl;
    }
  }

  discoveryUdp.stop();
  Serial.println("Monitor discovery timed out.");
  return "";
}

void handleMessage(WebsocketsMessage message) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, message.data());

  if (error) {
    Serial.print("JSON parse failed: ");
    Serial.println(error.c_str());
    return;
  }

  String type = doc["type"] | "";
  if (type == "tts_start") {
    handleTtsStart(doc);
    return;
  }
  if (type == "tts_audio") {
    handleTtsAudio(doc);
    return;
  }
  if (type == "tts_done") {
    handleTtsDone();
    return;
  }
  if (type == "voice_continue") {
    handleVoiceContinue(doc);
    return;
  }

  parseStatus(doc);
  needsFullRedraw = true;
}

void handleEvent(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    websocketConnected = true;
  } else if (event == WebsocketsEvent::ConnectionClosed) {
    websocketConnected = false;
  } else if (event == WebsocketsEvent::GotPing) {
    client.pong();
  } else if (event == WebsocketsEvent::GotPong) {
    Serial.println("Got pong");
  }

  if (data.length() > 0) {
    Serial.println(data);
  }
}

void handleTtsStart(JsonVariant source) {
  if (M5.Mic.isEnabled()) {
    while (M5.Mic.isRecording()) {
      M5.delay(1);
    }
    M5.Mic.end();
  }

  ttsSampleRate = source["sampleRate"] | TTS_SAMPLE_RATE_DEFAULT;
  if (ttsSampleRate == 0) {
    ttsSampleRate = TTS_SAMPLE_RATE_DEFAULT;
  }
  ttsAfterAction = source["after"] | "";
  ttsAfterAgent = source["agent"] | voiceStatus.agent;

  M5.Speaker.begin();
  M5.Speaker.setVolume(TTS_SPEAKER_VOLUME);
  M5.Speaker.setAllChannelVolume(255);
  M5.Speaker.stop(TTS_SPEAKER_CHANNEL);
  Serial.printf("tts_start sampleRate=%lu\n", static_cast<unsigned long>(ttsSampleRate));
  M5.delay(40);
  ttsPlaybackActive = true;
  voiceStatus.state = "speaking";
  voiceStatus.error = "";
  voiceStatus.hasAssistantElapsed = false;
  voiceStatus.assistantElapsedMs = 0;
  voiceStatus.assistantThinkingStartedAt = 0;
  needsFullRedraw = true;
}

void handleTtsAudio(JsonVariant source) {
  if (!ttsPlaybackActive) {
    handleTtsStart(source);
  }

  String encoded = source["audio"] | "";
  if (encoded.length() == 0) return;

  waitForTtsPlaybackSlot();
  size_t decodedBytes = decodeTtsAudio(encoded);
  decodedBytes -= decodedBytes % 2;
  if (decodedBytes == 0) return;

  const size_t sampleCount = decodedBytes / sizeof(int16_t);
  const bool queued = M5.Speaker.playRaw(ttsAudioBuffer, sampleCount, ttsSampleRate, false, 1, TTS_SPEAKER_CHANNEL, false);
  Serial.printf(
    "tts_audio encoded=%u decoded=%u samples=%u queued=%d\n",
    static_cast<unsigned>(encoded.length()),
    static_cast<unsigned>(decodedBytes),
    static_cast<unsigned>(sampleCount),
    queued ? 1 : 0
  );
  if (!queued || !waitForTtsPlaybackStart()) {
    voiceStatus.state = "error";
    voiceStatus.error = "speaker";
    needsFullRedraw = true;
  }
}

void handleTtsDone() {
  if (ttsPlaybackActive) {
    waitForTtsPlaybackSlot();
    M5.Speaker.end();
  }
  Serial.println("tts_done");
  ttsPlaybackActive = false;

  if (ttsAfterAction == "listen" && websocketConnected) {
    voiceSessionActive = true;
    voiceConversationMode = true;
    startVoiceRecording(agentIndexForKey(ttsAfterAgent), false, "continue");
    ttsAfterAction = "";
    ttsAfterAgent = "codex";
    return;
  }

  ttsAfterAction = "";
  ttsAfterAgent = "codex";
  if (voiceStatus.state == "speaking") {
    voiceStatus.state = "idle";
  }
  needsFullRedraw = true;
}

void handleVoiceContinue(JsonVariant source) {
  if (!websocketConnected) return;
  const String agent = source["agent"] | voiceStatus.agent;
  voiceSessionActive = true;
  voiceConversationMode = true;
  startVoiceRecording(agentIndexForKey(agent), false, "continue");
}

size_t decodeTtsAudio(const String& encoded) {
  size_t decodedBytes = 0;
  const int result = mbedtls_base64_decode(
    reinterpret_cast<unsigned char*>(ttsAudioBuffer),
    sizeof(ttsAudioBuffer),
    &decodedBytes,
    reinterpret_cast<const unsigned char*>(encoded.c_str()),
    encoded.length()
  );
  return result == 0 ? decodedBytes : 0;
}

void waitForTtsPlaybackSlot() {
  while (M5.Speaker.isPlaying(TTS_SPEAKER_CHANNEL)) {
    M5.update();
    M5.delay(1);
  }
}

bool waitForTtsPlaybackStart(unsigned long timeoutMs) {
  const unsigned long startedAt = millis();
  while (millis() - startedAt < timeoutMs) {
    if (M5.Speaker.isPlaying(TTS_SPEAKER_CHANNEL)) {
      return true;
    }
    M5.update();
    M5.delay(1);
  }
  return M5.Speaker.isPlaying(TTS_SPEAKER_CHANNEL);
}

void parseStatus(JsonDocument& doc) {
  JsonVariant root;
  if (doc["status"].isNull()) {
    root = doc.as<JsonVariant>();
  } else {
    root = doc["status"].as<JsonVariant>();
  }

  status.label = root["label"] | "Desktop";
  status.time = root["time"] | "--";
  status.cpu = root["cpu"]["percent"] | 0;
  status.mem = root["memory"]["percent"] | 0;

  if (root["battery"]["available"] | false) {
    status.battery = root["battery"]["percent"] | -1;
    status.charging = root["battery"]["charging"] | false;
  } else {
    status.battery = -1;
    status.charging = false;
  }

  if (root["git"]["available"] | false) {
    status.gitChanged = root["git"]["changed"] | 0;
    status.gitBranch = root["git"]["branch"] | "--";
  } else {
    status.gitChanged = -1;
    status.gitBranch = "--";
  }

  parseAgent(root["agents"]["codex"], codex, "Codex");
  parseAgent(root["agents"]["claude"], claude, "Claude Code");
  parseVoice(root["voice"]);

  status.alerts = "";
  JsonArray alerts = root["alerts"].as<JsonArray>();
  for (JsonVariant alert : alerts) {
    if (status.alerts.length() > 0) status.alerts += " ";
    status.alerts += alert.as<const char*>();
  }
}

void parseVoice(JsonVariant source) {
  if (source.isNull()) return;
  voiceStatus.state = source["state"] | voiceStatus.state;
  voiceStatus.agent = source["agent"] | voiceStatus.agent;
  voiceStatus.text = source["text"] | "";
  voiceStatus.error = source["error"] | "";
  if (!source["deviceWakeCue"].isNull()) {
    voiceStatus.deviceWakeCue = source["deviceWakeCue"].as<bool>();
  }

  if (!source["asr"]["latencyMs"].isNull()) {
    voiceStatus.asrLatencyMs = source["asr"]["latencyMs"].as<uint32_t>();
    voiceStatus.hasAsrLatency = true;
  } else if (!source["asr"]["elapsedMs"].isNull()) {
    voiceStatus.asrLatencyMs = source["asr"]["elapsedMs"].as<uint32_t>();
    voiceStatus.hasAsrLatency = true;
  }

  if (voiceStatus.state == "transcribing" && voiceStatus.asrTranscribingStartedAt == 0) {
    voiceStatus.asrTranscribingStartedAt = millis();
  } else if (voiceStatus.state != "transcribing") {
    voiceStatus.asrTranscribingStartedAt = 0;
  }

  if (!source["assistant"]["elapsedMs"].isNull()) {
    voiceStatus.assistantElapsedMs = source["assistant"]["elapsedMs"].as<uint32_t>();
    voiceStatus.hasAssistantElapsed = true;
    if (voiceStatus.state == "thinking") {
      voiceStatus.assistantThinkingStartedAt = millis();
    }
  } else if (voiceStatus.state == "thinking" && voiceStatus.assistantThinkingStartedAt == 0) {
    voiceStatus.assistantThinkingStartedAt = millis();
  } else if (voiceStatus.state != "thinking") {
    voiceStatus.hasAssistantElapsed = false;
    voiceStatus.assistantElapsedMs = 0;
    voiceStatus.assistantThinkingStartedAt = 0;
  }
}

void handleButtons() {
  const bool leftPressed = M5.BtnA.wasPressed();
  const bool rightPressed = M5.BtnB.wasPressed();
  const bool leftHeld = M5.BtnA.wasHold();
  const bool rightHeld = M5.BtnB.wasHold();
  const bool leftReleased = M5.BtnA.wasReleased();
  const bool leftReleasedAfterHold = M5.BtnA.wasReleasedAfterHold();
  if (!leftPressed && !rightPressed && !leftHeld && !rightHeld && !leftReleased && !leftReleasedAfterHold) return;

  if (voiceStatus.state == "recording") {
    if (leftPressed && voiceSessionActive && !voiceSawSpeech) {
      exportVoiceConversation();
      return;
    }
    if (leftPressed) {
      stopVoiceRecording();
      return;
    }
    if (rightHeld || leftReleasedAfterHold) {
      exitVoiceSession();
      return;
    }
    return;
  }

  if (voiceStatus.state == "speaking" || voiceStatus.state == "transcribing" || voiceStatus.state == "thinking") {
    return;
  }

  if (uiMode == UiMode::Config) {
    handleConfigButtons(leftPressed, rightPressed, leftHeld || rightHeld);
    return;
  }

  if (uiMode == UiMode::WifiList) {
    handleWifiListButtons(leftPressed, rightPressed, leftHeld || rightHeld);
    return;
  }

  if (uiMode == UiMode::WifiKeyboard) {
    handleWifiKeyboardButtons(leftPressed, rightPressed, leftHeld, rightHeld);
    return;
  }

  if (leftHeld || rightHeld) {
    cancelPendingVoiceSend();
    cancelPendingAgentSwitch();
    enterConfigScreen();
    return;
  }

  if (!leftPressed && !rightPressed) {
    return;
  }

  const int buttonIndex = leftPressed ? 0 : 1;
  const unsigned long now = millis();
  const bool doublePressed = lastVoiceButtonIndex == buttonIndex && now - lastVoiceButtonPress <= VOICE_DOUBLE_PRESS_MS;

  if (voiceSendPending && !doublePressed) {
    cancelPendingVoiceSend();
  }
  if (agentSwitchPending && !doublePressed) {
    cancelPendingAgentSwitch();
  }

  if (doublePressed) {
    cancelPendingAgentSwitch();
    lastVoiceButtonIndex = -1;
    lastVoiceButtonPress = 0;
    if (buttonIndex == 0) {
      cancelPendingVoiceSend();
      needsFullRedraw = true;
      startVoiceRecording(activeAgentIndex, false, "dictate");
      return;
    }
    if (voiceStatus.state == "ready") {
      sendVoiceTranscript();
      return;
    }
    cancelPendingVoiceSend();
    return;
  }

  if (rightPressed && voiceStatus.state == "ready") {
    scheduleVoiceSend();
    return;
  }

  if (leftPressed) {
    scheduleAgentSwitch();
    return;
  }

  lastVoiceButtonIndex = rightPressed ? 1 : -1;
  lastVoiceButtonPress = now;
}

void handleTouchInput() {
  auto touch = M5.Touch.getDetail();
  if (!touch.wasPressed() && !touch.wasClicked()) {
    return;
  }

  const unsigned long now = millis();
  if (now - lastTouchHandled < 180) {
    return;
  }
  lastTouchHandled = now;

  if (uiMode == UiMode::Config) {
    handleConfigTouch(touch.x, touch.y);
    return;
  }

  if (uiMode == UiMode::WifiList) {
    handleWifiListTouch(touch.x, touch.y);
    return;
  }

  if (uiMode == UiMode::WifiKeyboard) {
    handleWifiKeyboardTouch(touch.x, touch.y);
  }
}

void handleVoiceRecording() {
  if (voiceStatus.state != "recording") return;

  if (!websocketConnected) {
    voiceStatus.state = "error";
    voiceStatus.error = "offline";
    needsFullRedraw = true;
    return;
  }

  if (!M5.Mic.isEnabled()) return;

  if (M5.Mic.record(voiceAudioBuffer, VOICE_CHUNK_SAMPLES, VOICE_SAMPLE_RATE, false)) {
    client.sendBinary(reinterpret_cast<const char*>(voiceAudioBuffer), sizeof(voiceAudioBuffer));
    const uint32_t rms = voiceChunkRms(voiceAudioBuffer, VOICE_CHUNK_SAMPLES);
    if (rms >= VOICE_SPEECH_RMS_THRESHOLD) {
      voiceSawSpeech = true;
      lastVoiceSpeechAt = millis();
    }
  }

  const unsigned long silenceStopMs = voiceConversationMode
    ? VOICE_CONVERSATION_SILENCE_STOP_MS
    : VOICE_DICTATION_SILENCE_STOP_MS;
  if (voiceSawSpeech && millis() - lastVoiceSpeechAt > silenceStopMs) {
    stopVoiceRecording();
    return;
  }

  if (millis() - voiceRecordingStartedAt > VOICE_MAX_RECORDING_MS) {
    stopVoiceRecording();
  }
}

uint32_t voiceChunkRms(const int16_t* samples, size_t count) {
  if (samples == nullptr || count == 0) return 0;

  uint64_t sumSquares = 0;
  for (size_t i = 0; i < count; i++) {
    const int32_t sample = samples[i];
    sumSquares += uint64_t(sample * sample);
  }

  return static_cast<uint32_t>(sqrt(double(sumSquares) / double(count)));
}

void wakeVoiceAssistant(int agentIndex) {
  if (!websocketConnected) return;

  cancelPendingVoiceSend();
  cancelPendingAgentSwitch();
  activeAgentIndex = agentIndex;
  voiceSessionActive = true;
  voiceConversationMode = true;
  voiceStatus.state = "speaking";
  voiceStatus.agent = agentKey(agentIndex);
  voiceStatus.text = "";
  voiceStatus.error = "";
  voiceStatus.hasAsrLatency = false;
  voiceStatus.asrLatencyMs = 0;
  voiceStatus.asrTranscribingStartedAt = 0;
  voiceStatus.hasAssistantElapsed = false;
  voiceStatus.assistantElapsedMs = 0;
  voiceStatus.assistantThinkingStartedAt = 0;

  if (M5.Mic.isEnabled()) {
    while (M5.Mic.isRecording()) {
      M5.delay(1);
    }
    M5.Mic.end();
  }

  client.send("{\"type\":\"voice_wake\",\"agent\":\"" + voiceStatus.agent + "\"}");
  if (voiceStatus.deviceWakeCue) {
    playWakeCue();
    startVoiceRecording(agentIndex, false, "continue");
  }
  needsFullRedraw = true;
}

void exitVoiceSession() {
  cancelPendingVoiceSend();
  cancelPendingAgentSwitch();
  voiceSessionActive = false;
  voiceConversationMode = false;
  ttsAfterAction = "";

  if (M5.Mic.isEnabled()) {
    while (M5.Mic.isRecording()) {
      M5.delay(1);
    }
    M5.Mic.end();
  }

  M5.Speaker.stop(TTS_SPEAKER_CHANNEL);
  M5.Speaker.end();
  voiceStatus.state = "idle";
  voiceStatus.text = "";
  voiceStatus.error = "";
  voiceStatus.hasAsrLatency = false;
  voiceStatus.asrLatencyMs = 0;
  voiceStatus.asrTranscribingStartedAt = 0;
  voiceStatus.hasAssistantElapsed = false;
  voiceStatus.assistantElapsedMs = 0;
  voiceStatus.assistantThinkingStartedAt = 0;

  if (websocketConnected) {
    client.send("{\"type\":\"voice_exit\",\"agent\":\"" + voiceStatus.agent + "\"}");
  }
  needsFullRedraw = true;
}

void playWakeCue() {
  const double twoPi = 6.283185307179586;
  for (size_t i = 0; i < WAKE_CUE_SAMPLES; i++) {
    const double phase = double(i) / double(WAKE_CUE_SAMPLE_RATE);
    const double frequency = i < WAKE_CUE_SAMPLES / 2 ? 880.0 : 1174.66;
    double envelope = 1.0;
    if (i < 80) {
      envelope = double(i) / 80.0;
    } else if (i > WAKE_CUE_SAMPLES - 160) {
      envelope = double(WAKE_CUE_SAMPLES - i) / 160.0;
    }
    wakeCueBuffer[i] = static_cast<int16_t>(sin(twoPi * frequency * phase) * WAKE_CUE_AMPLITUDE * envelope);
  }

  M5.Speaker.begin();
  M5.Speaker.setVolume(TTS_SPEAKER_VOLUME);
  M5.Speaker.setAllChannelVolume(255);
  M5.Speaker.stop(TTS_SPEAKER_CHANNEL);
  const bool queued = M5.Speaker.playRaw(
    wakeCueBuffer,
    WAKE_CUE_SAMPLES,
    WAKE_CUE_SAMPLE_RATE,
    false,
    1,
    TTS_SPEAKER_CHANNEL,
    false
  );
  if (queued && waitForTtsPlaybackStart(30)) {
    waitForTtsPlaybackSlot();
  }
  M5.Speaker.end();
}

void startVoiceRecording(int agentIndex, bool announce, const char* mode) {
  if (announce) {
    wakeVoiceAssistant(agentIndex);
    return;
  }

  if (!websocketConnected) return;

  cancelPendingVoiceSend();
  cancelPendingAgentSwitch();
  activeAgentIndex = agentIndex;
  const bool continueMode = String(mode) == "continue";
  voiceSessionActive = continueMode;
  voiceConversationMode = continueMode;
  voiceStatus.state = "recording";
  voiceStatus.agent = agentKey(agentIndex);
  voiceStatus.text = "";
  voiceStatus.error = "";
  voiceStatus.hasAsrLatency = false;
  voiceStatus.asrLatencyMs = 0;
  voiceStatus.asrTranscribingStartedAt = 0;
  voiceStatus.hasAssistantElapsed = false;
  voiceStatus.assistantElapsedMs = 0;
  voiceStatus.assistantThinkingStartedAt = 0;
  lastVoiceButtonPress = millis();
  voiceRecordingStartedAt = lastVoiceButtonPress;
  lastVoiceSpeechAt = voiceRecordingStartedAt;
  voiceSawSpeech = false;

  M5.Speaker.end();
  if (!M5.Mic.isEnabled()) {
    M5.Mic.begin();
  }

  client.send("{\"type\":\"voice_start\",\"agent\":\"" + voiceStatus.agent + "\",\"mode\":\"" + String(mode) + "\"}");
  needsFullRedraw = true;
}

void stopVoiceRecording() {
  if (M5.Mic.isEnabled()) {
    while (M5.Mic.isRecording()) {
      M5.delay(1);
    }
    M5.Mic.end();
  }

  voiceStatus.state = "transcribing";
  voiceStatus.asrTranscribingStartedAt = millis();
  voiceStatus.hasAsrLatency = false;
  voiceStatus.asrLatencyMs = 0;
  voiceStatus.hasAssistantElapsed = false;
  voiceStatus.assistantElapsedMs = 0;
  voiceStatus.assistantThinkingStartedAt = 0;
  if (!voiceConversationMode) {
    voiceSessionActive = false;
  }
  client.send("{\"type\":\"voice_stop\"}");
  needsFullRedraw = true;
}

void exportVoiceConversation() {
  if (M5.Mic.isEnabled()) {
    while (M5.Mic.isRecording()) {
      M5.delay(1);
    }
    M5.Mic.end();
  }

  voiceSessionActive = false;
  voiceConversationMode = false;
  voiceSawSpeech = false;
  voiceStatus.state = "transcribing";
  voiceStatus.asrTranscribingStartedAt = millis();
  voiceStatus.hasAsrLatency = false;
  voiceStatus.asrLatencyMs = 0;
  voiceStatus.hasAssistantElapsed = false;
  voiceStatus.assistantElapsedMs = 0;
  voiceStatus.assistantThinkingStartedAt = 0;
  client.send("{\"type\":\"voice_export\",\"agent\":\"" + voiceStatus.agent + "\"}");
  needsFullRedraw = true;
}

void sendVoiceTranscript() {
  cancelPendingVoiceSend();
  cancelPendingAgentSwitch();
  client.send("{\"type\":\"voice_send\"}");
  voiceStatus.state = "idle";
  needsFullRedraw = true;
}

void scheduleVoiceSend() {
  cancelPendingAgentSwitch();
  voiceSendPending = true;
  voiceSendPendingAt = millis();
  lastVoiceButtonIndex = 1;
  lastVoiceButtonPress = voiceSendPendingAt;
}

void cancelPendingVoiceSend() {
  voiceSendPending = false;
  voiceSendPendingAt = 0;
}

void handlePendingVoiceSend() {
  if (!voiceSendPending) return;

  if (voiceStatus.state != "ready") {
    cancelPendingVoiceSend();
    return;
  }

  if (millis() - voiceSendPendingAt < VOICE_DOUBLE_PRESS_MS) {
    return;
  }

  cancelPendingVoiceSend();
  lastVoiceButtonIndex = -1;
  lastVoiceButtonPress = 0;
  sendVoiceTranscript();
}

void scheduleAgentSwitch() {
  cancelPendingVoiceSend();
  agentSwitchPending = true;
  agentSwitchPendingAt = millis();
  lastVoiceButtonIndex = 0;
  lastVoiceButtonPress = agentSwitchPendingAt;
}

void cancelPendingAgentSwitch() {
  agentSwitchPending = false;
  agentSwitchPendingAt = 0;
}

void handlePendingAgentSwitch() {
  if (!agentSwitchPending) return;

  if (voiceStatus.state != "idle") {
    cancelPendingAgentSwitch();
    return;
  }

  if (millis() - agentSwitchPendingAt < VOICE_DOUBLE_PRESS_MS) {
    return;
  }

  cancelPendingAgentSwitch();
  lastVoiceButtonIndex = -1;
  lastVoiceButtonPress = 0;
  toggleActiveAgent();
}

void toggleActiveAgent() {
  activeAgentIndex = activeAgentIndex == 0 ? 1 : 0;
  needsFullRedraw = true;
}

void handleConfigButtons(bool leftPressed, bool rightPressed, bool held) {
  if (held) {
    exitConfigScreen();
    return;
  }

  if (leftPressed) {
    selectedConfigItem = (selectedConfigItem + 1) % CONFIG_MENU_COUNT;
    configMessage = "Select";
    needsFullRedraw = true;
    return;
  }

  if (rightPressed) {
    performConfigAction(CONFIG_MENU[selectedConfigItem].action);
  }
}

void handleWifiListButtons(bool leftPressed, bool rightPressed, bool held) {
  if (held) {
    uiMode = UiMode::Config;
    configMessage = "Wi-Fi canceled";
    needsFullRedraw = true;
    return;
  }

  if (leftPressed) {
    if (wifiNetworkCount == 0) {
      scanWiFiNetworks();
      wifiSetupMessage = wifiNetworkCount > 0 ? "Select Wi-Fi" : "No networks";
    } else {
      selectedWifiIndex = (selectedWifiIndex + 1) % wifiNetworkCount;
      wifiSetupMessage = "Select Wi-Fi";
    }
    needsFullRedraw = true;
    return;
  }

  if (rightPressed) {
    if (wifiNetworkCount == 0) {
      scanWiFiNetworks();
      wifiSetupMessage = wifiNetworkCount > 0 ? "Select Wi-Fi" : "No networks";
      needsFullRedraw = true;
      return;
    }

    selectedWifiSsid = wifiSsids[selectedWifiIndex];
    typedWifiPassword = "";
    keyboardIndex = 0;
    keyboardPage = 0;
    wifiSetupMessage = "Enter password";
    uiMode = UiMode::WifiKeyboard;
    needsFullRedraw = true;
  }
}

void handleWifiKeyboardButtons(bool leftPressed, bool rightPressed, bool leftHeld, bool rightHeld) {
  if (rightHeld) {
    connectSelectedWiFi();
    return;
  }

  if (leftHeld) {
    if (typedWifiPassword.length() > 0) {
      typedWifiPassword.remove(typedWifiPassword.length() - 1);
      wifiSetupMessage = "Deleted";
    } else {
      uiMode = UiMode::WifiList;
      wifiSetupMessage = "Select Wi-Fi";
    }
    needsFullRedraw = true;
    return;
  }

  if (leftPressed) {
    keyboardIndex = (keyboardIndex + 1) % strlen(KEYBOARD_CHARS);
    wifiSetupMessage = "Pick char";
    needsFullRedraw = true;
    return;
  }

  if (rightPressed) {
    appendKeyboardChar(currentKeyboardChar());
  }
}

void handleConfigTouch(int32_t x, int32_t y) {
  for (size_t index = 0; index < CONFIG_MENU_COUNT; index++) {
    if (!pointInRect(x, y, configMenuTileX(index), configMenuTileY(index), CONFIG_MENU_TILE_WIDTH, CONFIG_MENU_TILE_HEIGHT)) {
      continue;
    }

    selectedConfigItem = index;
    needsFullRedraw = true;
    performConfigAction(CONFIG_MENU[index].action);
    return;
  }
}

void handleWifiListTouch(int32_t x, int32_t y) {
  if (wifiNetworkCount == 0) {
    scanWiFiNetworks();
    wifiSetupMessage = wifiNetworkCount > 0 ? "Select Wi-Fi" : "No networks";
    needsFullRedraw = true;
    return;
  }

  const size_t visible = min<size_t>(wifiNetworkCount, 5);
  const size_t start = selectedWifiIndex >= visible ? selectedWifiIndex - visible + 1 : 0;
  for (size_t row = 0; row < visible; row++) {
    const size_t index = start + row;
    const int32_t rowY = WIFI_LIST_TOP + int32_t(row) * (WIFI_LIST_ROW_HEIGHT + WIFI_LIST_ROW_GAP);
    if (!pointInRect(x, y, WIFI_LIST_LEFT, rowY, WIFI_LIST_WIDTH, WIFI_LIST_ROW_HEIGHT)) {
      continue;
    }

    selectedWifiIndex = index;
    selectedWifiSsid = wifiSsids[index];
    typedWifiPassword = "";
    keyboardIndex = 0;
    keyboardPage = 0;
    wifiSetupMessage = "Enter password";
    uiMode = UiMode::WifiKeyboard;
    needsFullRedraw = true;
    return;
  }
}

void handleWifiKeyboardTouch(int32_t x, int32_t y) {
  const int keyIndex = keyboardKeyAt(x, y);
  if (keyIndex >= 0) {
    appendKeyboardChar(currentKeyboardPage()[keyIndex]);
    return;
  }

  if (pointInRect(x, y, PASSWORD_DELETE_LEFT, PASSWORD_DELETE_TOP, PASSWORD_DELETE_WIDTH, PASSWORD_DELETE_HEIGHT)) {
    handlePasswordDelete();
    return;
  }

  if (pointInRect(x, y,
                  KEYBOARD_ACTION_PAGE_LEFT - KEYBOARD_ACTION_TOUCH_PADDING,
                  KEYBOARD_ACTION_PAGE_TOP - KEYBOARD_ACTION_TOUCH_PADDING,
                  KEYBOARD_ACTION_PAGE_WIDTH + KEYBOARD_ACTION_TOUCH_PADDING * 2,
                  KEYBOARD_ACTION_PAGE_HEIGHT + KEYBOARD_ACTION_TOUCH_PADDING * 2)) {
    switchKeyboardPage();
    return;
  }

  if (pointInRect(x, y,
                  KEYBOARD_ACTION_OK_LEFT - KEYBOARD_ACTION_TOUCH_PADDING,
                  KEYBOARD_ACTION_OK_TOP - KEYBOARD_ACTION_TOUCH_PADDING,
                  KEYBOARD_ACTION_OK_WIDTH + KEYBOARD_ACTION_TOUCH_PADDING * 2,
                  KEYBOARD_ACTION_OK_HEIGHT + KEYBOARD_ACTION_TOUCH_PADDING * 2)) {
    connectSelectedWiFi();
    return;
  }
}

void handlePasswordDelete() {
  if (typedWifiPassword.length() > 0) {
    typedWifiPassword.remove(typedWifiPassword.length() - 1);
    wifiSetupMessage = "Deleted";
  } else {
    wifiSetupMessage = "Empty";
  }
  needsFullRedraw = true;
}

void appendKeyboardChar(char c) {
  if (typedWifiPassword.length() >= MAX_WIFI_PASSWORD_LENGTH) {
    wifiSetupMessage = "Password full";
    needsFullRedraw = true;
    return;
  }

  typedWifiPassword += c;
  wifiSetupMessage = "Added";
  needsFullRedraw = true;
}

void switchKeyboardPage() {
  keyboardPage = (keyboardPage + 1) % KEYBOARD_PAGE_COUNT;
  wifiSetupMessage = String(KEYBOARD_PAGE_LABELS[keyboardPage]);
  needsFullRedraw = true;
}

void enterConfigScreen() {
  uiMode = UiMode::Config;
  selectedConfigItem = 0;
  configMessage = "Config";
  needsFullRedraw = true;
}

void exitConfigScreen() {
  uiMode = UiMode::Dashboard;
  configMessage = "Ready";
  needsFullRedraw = true;
}

void performConfigAction(ConfigAction action) {
  switch (action) {
    case ConfigAction::ReconnectServer:
      configMessage = "Reconnecting WS";
      websocketConnected = false;
      client.close();
      connectWebSocket();
      uiMode = UiMode::Config;
      configMessage = websocketConnected ? "Device WS connected" : "Device WS offline";
      needsFullRedraw = true;
      break;
    case ConfigAction::WifiSetup:
      configMessage = "Wi-Fi setup";
      beginOnDeviceWiFiSetup();
      break;
    case ConfigAction::WifiPortal:
      configMessage = "Wi-Fi portal";
      websocketConnected = false;
      client.close();
      WiFi.disconnect(true);
      delay(100);
      startWiFiSetupPortal();
      if (WiFi.status() == WL_CONNECTED) {
        connectWebSocket();
      }
      uiMode = UiMode::Config;
      configMessage = WiFi.status() == WL_CONNECTED ? "Wi-Fi ready" : "Wi-Fi offline";
      needsFullRedraw = true;
      break;
    case ConfigAction::Exit:
      exitConfigScreen();
      break;
  }
}

void parseAgent(JsonVariant source, AgentStatus& target, const String& fallbackName) {
  if (source.isNull()) {
    target.name = fallbackName;
    target.online = false;
    target.state = "offline";
    target.task = "";
    resetAgentMetrics(target);
    return;
  }

  target.name = source["name"] | fallbackName;
  target.online = source["online"] | false;
  target.state = source["state"] | (target.online ? "online" : "offline");
  target.task = source["task"] | "";
  resetAgentMetrics(target);
  target.tokenPercent = source["tokens"]["percent"].isNull() ? -1 : int(source["tokens"]["percent"]);
  target.progress = source["progress"].isNull() ? -1 : int(source["progress"]);
  if (!source["tokens"]["used"].isNull()) {
    target.usageTotal = source["tokens"]["used"].as<uint64_t>();
    target.hasUsageTotal = true;
  }

  JsonArray usageWindows = source["usageWindows"].as<JsonArray>();
  if (!usageWindows.isNull()) {
    JsonVariant primaryWindow = usageWindows[0];
    if (!primaryWindow.isNull()) {
      target.hasUsageWindows = true;
      target.primaryUsageLabel = primaryWindow["label"] | target.primaryUsageLabel;
      target.primaryUsagePercent = primaryWindow["remainingPercent"].isNull()
        ? target.primaryUsagePercent
        : int(primaryWindow["remainingPercent"]);
      target.primaryUsageReset = primaryWindow["resetText"] | target.primaryUsageReset;
    }

    JsonVariant secondaryWindow = usageWindows[1];
    if (!secondaryWindow.isNull()) {
      target.hasUsageWindows = true;
      target.secondaryUsageLabel = secondaryWindow["label"] | target.secondaryUsageLabel;
      target.secondaryUsagePercent = secondaryWindow["remainingPercent"].isNull()
        ? target.secondaryUsagePercent
        : int(secondaryWindow["remainingPercent"]);
      target.secondaryUsageReset = secondaryWindow["resetText"] | target.secondaryUsageReset;
    }
  }

  parseTrend(source["trends"]["usage"], target.usageTotal, target.hasUsageTotal, target.usageTrend, target.usageTrendCount);
  parseTrend(source["trends"]["weekly"], target.weeklyTotal, target.hasWeeklyTotal, target.weeklyTrend, target.weeklyTrendCount);
}

void resetAgentMetrics(AgentStatus& target) {
  target.tokenPercent = -1;
  target.progress = -1;
  target.primaryUsageLabel = "5h";
  target.primaryUsagePercent = -1;
  target.primaryUsageReset = "--";
  target.secondaryUsageLabel = "1w";
  target.secondaryUsagePercent = -1;
  target.secondaryUsageReset = "--";
  target.hasUsageWindows = false;
  target.usageTotal = 0;
  target.hasUsageTotal = false;
  target.weeklyTotal = 0;
  target.hasWeeklyTotal = false;
  target.usageTrendCount = 0;
  target.weeklyTrendCount = 0;
  for (size_t i = 0; i < MAX_TREND_POINTS; i++) {
    target.usageTrend[i] = 0;
    target.weeklyTrend[i] = 0;
  }
}

void parseTrend(JsonVariant source, uint64_t& total, bool& hasTotal, uint64_t* points, size_t& count) {
  count = 0;
  if (source.isNull()) return;

  if (!source["total"].isNull()) {
    total = source["total"].as<uint64_t>();
    hasTotal = true;
  }

  JsonArray values = source["points"].as<JsonArray>();
  if (values.isNull()) return;

  for (JsonVariant value : values) {
    if (count >= MAX_TREND_POINTS || value.isNull()) continue;
    points[count++] = value.as<uint64_t>();
  }
}

void drawBootScreen(const String& line) {
  M5.Display.fillScreen(COLOR_BG);
  M5.Display.drawCircle(233, 233, 226, COLOR_PANEL);
  drawCenteredText("STOPWATCH", 156, &fonts::Font4, COLOR_TEXT);
  drawCenteredText(line, 218, &fonts::Font4, COLOR_BLUE);
  drawCenteredText(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "desktop monitor", 276, &fonts::Font2, COLOR_MUTED);
}

void drawStatus() {
  if (screenCanvasReady) {
    drawTarget = &screenCanvas;
  } else {
    drawTarget = &M5.Display;
  }

  drawTarget->fillScreen(COLOR_BG);
  if (uiMode == UiMode::Config) {
    drawConfigScreen();
  } else if (uiMode == UiMode::WifiList) {
    drawWifiListScreen();
  } else if (uiMode == UiMode::WifiKeyboard) {
    drawWifiKeyboardScreen();
  } else if (activeAgentIndex == 0) {
    drawSingleAgentDashboard(codex, COLOR_BLUE, CODEX_LOGO);
  } else {
    drawSingleAgentDashboard(claude, COLOR_YELLOW, CLAUDE_LOGO);
  }

  if (screenCanvasReady) {
    screenCanvas.pushSprite(0, 0);
    drawTarget = &M5.Display;
  }
}

void drawConfigScreen() {
  drawTarget->fillCircle(233, 233, 229, COLOR_PANEL);
  drawTarget->fillCircle(233, 233, 211, COLOR_BG);

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font4);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString("CONFIG", 233, 58);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString("Tap item or use A/B", 233, 88);

  drawConfigStatusPanel();
  for (size_t index = 0; index < CONFIG_MENU_COUNT; index++) {
    drawConfigMenuTile(index);
  }

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(truncateText(configMessage, 20), 233, CONFIG_MESSAGE_Y);
}

void drawConfigValue(const String& label, const String& value, int32_t y, uint16_t valueColor) {
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextDatum(middle_left);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(label, 88, y);
  drawTarget->setTextDatum(middle_right);
  drawTarget->setTextColor(valueColor, COLOR_BG);
  drawTarget->drawString(value, 378, y);
}

void drawConfigMenuRow(size_t index, int32_t y) {
  const bool selected = index == selectedConfigItem;
  const uint16_t bg = selected ? COLOR_PANEL : COLOR_BG;
  const uint16_t stroke = selected ? COLOR_CYAN : 0x39E7;

  drawTarget->fillRoundRect(CONFIG_MENU_LEFT, y - 13, CONFIG_MENU_WIDTH, 25, 6, bg);
  drawTarget->drawRoundRect(CONFIG_MENU_LEFT, y - 13, CONFIG_MENU_WIDTH, 25, 6, stroke);
  drawTarget->setTextDatum(middle_left);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(selected ? COLOR_TEXT : COLOR_MUTED, bg);
  drawTarget->drawString(String(selected ? "> " : "  ") + CONFIG_MENU[index].label, CONFIG_MENU_LEFT + 14, y);
}

void drawConfigStatusPanel() {
  const uint16_t wifiColor = WiFi.status() == WL_CONNECTED ? COLOR_GREEN : COLOR_RED;
  const uint16_t serverColor = websocketConnected ? COLOR_GREEN : COLOR_RED;
  drawConfigStatusRow("Wi-Fi", WiFi.status() == WL_CONNECTED ? WiFi.SSID() : "disconnected", CONFIG_STATUS_TOP + 20, wifiColor);
  drawConfigStatusRow("IP", WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "--", CONFIG_STATUS_TOP + 45);
  drawConfigStatusRow("Device WS", websocketConnected ? "connected" : "offline", CONFIG_STATUS_TOP + 70, serverColor);
  drawConfigStatusRow("Voice", voiceStatus.state, CONFIG_STATUS_TOP + 95, voiceStatus.state == "error" ? COLOR_RED : COLOR_TEXT);
}

void drawConfigStatusRow(const String& label, const String& value, int32_t y, uint16_t valueColor) {
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextDatum(middle_left);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(label, CONFIG_STATUS_LEFT + 16, y);
  drawTarget->setTextDatum(middle_right);
  drawTarget->setTextColor(valueColor, COLOR_BG);
  drawTarget->drawString(truncateText(value, 14), CONFIG_STATUS_LEFT + CONFIG_STATUS_WIDTH - 16, y);
}

void drawConfigMenuTile(size_t index) {
  const bool selected = index == selectedConfigItem;
  const int32_t x = configMenuTileX(index);
  const int32_t y = configMenuTileY(index);

  drawTarget->fillCircle(x + 18, y + CONFIG_MENU_TILE_HEIGHT / 2, 5, selected ? COLOR_CYAN : COLOR_MUTED);
  drawTarget->setTextDatum(middle_left);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(selected ? COLOR_TEXT : COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(truncateText(CONFIG_MENU[index].label, 12), x + 34, y + CONFIG_MENU_TILE_HEIGHT / 2);
}

int32_t configMenuTileX(size_t index) {
  const int32_t col = int32_t(index % CONFIG_MENU_COLS);
  return CONFIG_MENU_LEFT + col * (CONFIG_MENU_TILE_WIDTH + CONFIG_MENU_GAP_X);
}

int32_t configMenuTileY(size_t index) {
  const int32_t row = int32_t(index / CONFIG_MENU_COLS);
  return CONFIG_MENU_TOP + row * (CONFIG_MENU_TILE_HEIGHT + CONFIG_MENU_GAP_Y);
}

void drawWifiListScreen() {
  drawTarget->fillCircle(233, 233, 229, COLOR_PANEL);
  drawTarget->fillCircle(233, 233, 211, COLOR_BG);

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font4);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString("SELECT WI-FI", 233, 82);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString("Tap Wi-Fi name  Hold back", 233, 112);

  if (wifiNetworkCount == 0) {
    drawTarget->setTextColor(COLOR_YELLOW, COLOR_BG);
    drawTarget->drawString("No networks found", 233, 220);
    drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
    drawTarget->drawString("Press A or B to rescan", 233, 250);
  } else {
    const size_t visible = min<size_t>(wifiNetworkCount, 5);
    const size_t start = selectedWifiIndex >= visible ? selectedWifiIndex - visible + 1 : 0;
    for (size_t row = 0; row < visible; row++) {
      const size_t index = start + row;
      const int32_t top = WIFI_LIST_TOP + int32_t(row) * (WIFI_LIST_ROW_HEIGHT + WIFI_LIST_ROW_GAP);
      const int32_t y = top + WIFI_LIST_ROW_HEIGHT / 2;
      const bool selected = index == selectedWifiIndex;
      drawTarget->fillCircle(WIFI_LIST_LEFT + 10, y, 4, selected ? COLOR_CYAN : COLOR_MUTED);
      drawTarget->setTextDatum(middle_left);
      drawTarget->setFont(&fonts::Font2);
      drawTarget->setTextColor(selected ? COLOR_TEXT : COLOR_MUTED, COLOR_BG);
      drawTarget->drawString(truncateText(wifiSsids[index], 18), WIFI_LIST_LEFT + 24, y);
      drawTarget->setTextDatum(middle_right);
      drawTarget->setTextColor(wifiRssi[index] > -65 ? COLOR_GREEN : COLOR_YELLOW, COLOR_BG);
      drawTarget->drawString(String(wifiRssi[index]) + "dB", WIFI_LIST_LEFT + WIFI_LIST_WIDTH - 18, y);
    }
  }

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(truncateText(wifiSetupMessage, 20), 233, WIFI_LIST_MESSAGE_Y);
}

void drawWifiKeyboardScreen() {
  drawTarget->fillCircle(233, 233, 229, COLOR_PANEL);
  drawTarget->fillCircle(233, 233, 211, COLOR_BG);

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font4);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString("PASSWORD", 233, 56);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(truncateText(selectedWifiSsid, 24), 233, 84);

  drawPasswordInputPanel();

  const size_t keyCount = currentKeyboardPageLength();
  for (size_t index = 0; index < keyCount; index++) {
    const int32_t row = index / KEYBOARD_COLS;
    const int32_t col = index % KEYBOARD_COLS;
    const int32_t x = KEYBOARD_LEFT + col * (KEYBOARD_KEY_WIDTH + KEYBOARD_KEY_GAP);
    const int32_t y = KEYBOARD_TOP + row * (KEYBOARD_KEY_HEIGHT + KEYBOARD_KEY_GAP);
    drawKeyboardKey(index, x, y, KEYBOARD_KEY_WIDTH, KEYBOARD_KEY_HEIGHT);
  }

  drawKeyboardActionBar();
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextDatum(middle_center);
  drawTarget->setTextColor(COLOR_YELLOW, COLOR_BG);
  drawTarget->drawString(truncateText(wifiSetupMessage, 18), 233, KEYBOARD_STATUS_Y);
}

void drawPasswordInputPanel() {
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextDatum(middle_right);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(String(typedWifiPassword.length()) + "/64", PASSWORD_DELETE_LEFT - 10, PASSWORD_PANEL_TOP + 17);

  drawTarget->setTextDatum(middle_center);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(passwordInputText(), PASSWORD_PANEL_LEFT + 122, PASSWORD_PANEL_TOP + 40);

  drawPasswordDeleteButton();
}

void drawPasswordDeleteButton() {
  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_YELLOW, COLOR_BG);
  drawTarget->drawString("Del", PASSWORD_DELETE_LEFT + PASSWORD_DELETE_WIDTH / 2, PASSWORD_DELETE_TOP + PASSWORD_DELETE_HEIGHT / 2);
}

void drawKeyboardActionBar() {
  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->fillCircle(KEYBOARD_ACTION_PAGE_LEFT + 10, KEYBOARD_ACTION_PAGE_TOP + 10, 4, COLOR_CYAN);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(KEYBOARD_PAGE_LABELS[keyboardPage],
                         KEYBOARD_ACTION_PAGE_LEFT + KEYBOARD_ACTION_PAGE_WIDTH / 2,
                         KEYBOARD_ACTION_PAGE_TOP + KEYBOARD_ACTION_PAGE_HEIGHT / 2);

  drawTarget->fillCircle(KEYBOARD_ACTION_OK_LEFT + KEYBOARD_ACTION_OK_WIDTH / 2,
                         KEYBOARD_ACTION_OK_TOP + 12,
                         4,
                         COLOR_GREEN);
  drawTarget->setTextColor(COLOR_GREEN, COLOR_BG);
  drawTarget->drawString("OK",
                         KEYBOARD_ACTION_OK_LEFT + KEYBOARD_ACTION_OK_WIDTH / 2,
                         KEYBOARD_ACTION_OK_TOP + KEYBOARD_ACTION_OK_HEIGHT / 2);
}

void drawKeyboardKey(size_t index, int32_t x, int32_t y, int32_t w, int32_t h) {
  if (index >= currentKeyboardPageLength()) {
    return;
  }

  drawTarget->fillRoundRect(x, y, w, h, 6, COLOR_PANEL);
  drawTarget->drawRoundRect(x, y, w, h, 6, 0x39E7);
  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_PANEL);
  drawTarget->drawString(String(currentKeyboardPage()[index]), x + w / 2, y + h / 2);
}

void drawMetricArc(int32_t x, int32_t y, int32_t r, int value, uint16_t color, const String& labelText) {
  value = constrain(value, 0, 100);
  drawTarget->drawArc(x, y, r, r - 8, -210, 30, 0x39E7);
  drawTarget->drawArc(x, y, r, r - 8, -210, map(value, 0, 100, -210, 30), color);

  drawTarget->setTextDatum(middle_center);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->setFont(&fonts::Font4);
  drawTarget->drawString(String(value) + "%", x, y - 6);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->drawString(labelText, x, y + 30);
}

void drawAgentColumn(int32_t centerX, const AgentStatus& agent, uint16_t accent) {
  const int32_t left = centerX - 88;
  drawTarget->fillRoundRect(left, 126, 176, 218, 8, COLOR_PANEL);
  drawTarget->drawRoundRect(left, 126, 176, 218, 8, agent.online ? accent : 0x39E7);
  const uint16_t* logo = agent.name == "Codex" ? CODEX_LOGO : CLAUDE_LOGO;
  pushRgb565Image(centerX - AGENT_LOGO_SIZE / 2, 138, AGENT_LOGO_SIZE, AGENT_LOGO_SIZE, logo);

  drawTarget->setTextDatum(middle_center);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_PANEL);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->drawString(agent.name, centerX, 188);

  uint16_t stateColor = agent.online ? COLOR_GREEN : COLOR_MUTED;
  drawTarget->fillCircle(centerX - 42, 214, 5, stateColor);
  drawTarget->setTextColor(stateColor, COLOR_PANEL);
  drawTarget->drawString(truncateText(agent.state, 12), centerX + 12, 214);

  uint16_t tokenColor = agent.tokenPercent < 0 ? COLOR_MUTED : colorForPercent(agent.tokenPercent);
  drawTarget->setTextColor(tokenColor, COLOR_PANEL);
  drawTarget->setFont(&fonts::Font4);
  drawTarget->drawString(percentText(agent.tokenPercent), centerX, 252);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_PANEL);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->drawString("TOKENS", centerX, 280);

  drawTarget->setTextColor(agent.progress < 0 ? COLOR_MUTED : COLOR_TEXT, COLOR_PANEL);
  drawTarget->setFont(&fonts::Font4);
  drawTarget->drawString(percentText(agent.progress), centerX, 318);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_PANEL);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->drawString("TASK", centerX, 338);
}

void drawSingleAgentDashboard(const AgentStatus& agent, uint16_t accent, const uint16_t* logo) {
  drawTarget->fillCircle(233, 233, 229, COLOR_PANEL);
  drawTarget->fillCircle(233, 233, 211, COLOR_BG);

  drawAgentStateRing(agent, accent);

  drawAnimatedLogo(agent, logo, animatedLogoBob());
  drawVoiceIndicator(accent);

  drawUsageTrends(agent, accent);
  drawUsageWindowFooter(agent, accent);

  drawTarget->fillRoundRect(213, 407, 28, 7, 4, accent);
  drawTarget->fillCircle(251, 410, 3, activeAgentIndex == 0 ? COLOR_MUTED : COLOR_TEXT);
  drawTarget->fillCircle(233, 410, 3, activeAgentIndex == 0 ? COLOR_TEXT : COLOR_MUTED);
}

void drawAgentStateRing(const AgentStatus& agent, uint16_t accent) {
  const bool voiceAgent = isVoiceStateForAgent(agent);
  const bool recording = voiceAgent && voiceStatus.state == "recording";
  const bool transcribing = voiceAgent && voiceStatus.state == "transcribing";
  const bool thinking = voiceAgent && voiceStatus.state == "thinking";
  const bool ready = voiceAgent && voiceStatus.state == "ready";
  const bool error = voiceAgent && voiceStatus.state == "error";

  drawTarget->drawArc(233, 233, 224, 221, -220, 220, COLOR_RING_DIM);
  drawTarget->drawArc(233, 233, 216, 214, -218, 218, COLOR_RING_DIM);

  const uint16_t agentColor = agent.online ? accent : COLOR_RING_TRACK;
  drawTarget->drawArc(233, 233, 224, 221, -210, -172, agentColor);

  if (ready) {
    drawTarget->drawArc(233, 233, 224, 221, -28, 28, COLOR_GREEN);
    return;
  }

  if (error) {
    const uint16_t flashColor = ((millis() / VOICE_ANIMATION_MS) % 2) == 0 ? COLOR_RED : COLOR_YELLOW;
    drawTarget->drawArc(233, 233, 226, 221, -216, 216, flashColor);
    return;
  }

  if (recording) {
    const int32_t pulse = (millis() / VOICE_ANIMATION_MS) % 4;
    const int32_t outer = 223 + pulse;
    drawTarget->drawArc(233, 233, outer, outer - 4, -215, 215, accent);
    drawTarget->drawArc(233, 233, outer - 7, outer - 10, -155, 155, COLOR_CYAN);
    return;
  }

  if (thinking) {
    const int32_t segmentStart = -220 + int32_t((millis() / VOICE_ANIMATION_MS) % 12) * 36;
    drawTarget->drawArc(233, 233, 225, 221, segmentStart, segmentStart + 44, COLOR_VIOLET);
    drawTarget->drawArc(233, 233, 218, 216, segmentStart - 30, segmentStart + 16, COLOR_YELLOW);
    return;
  }

  if (transcribing) {
    const int32_t segmentStart = -220 + int32_t((millis() / VOICE_ANIMATION_MS) % 12) * 36;
    drawTarget->drawArc(233, 233, 225, 221, segmentStart, segmentStart + 34, COLOR_YELLOW);
    drawTarget->drawArc(233, 233, 218, 216, segmentStart - 24, segmentStart + 12, accent);
  }
}

bool isVoiceStateForAgent(const AgentStatus& agent) {
  if (agent.name == "Codex") {
    return voiceStatus.agent == "codex";
  }

  if (agent.name == "Claude Code") {
    return voiceStatus.agent == "claude";
  }

  return false;
}

int animatedLogoBob() {
  const int offsets[] = {0, -1, -1, 0, 0, 1, 1, 0};
  const size_t index = (millis() / LOGO_ANIMATION_MS) % (sizeof(offsets) / sizeof(offsets[0]));
  return offsets[index];
}

void drawAnimatedLogo(const AgentStatus& agent, const uint16_t* logo, int bob) {
  if (agent.name == "Codex") {
    const int x = 233 - THREE_D_LOGO_SIZE / 2;
    const int y = 68 + bob;
    drawTransparentRgb565Image(x, y, THREE_D_LOGO_SIZE, THREE_D_LOGO_SIZE, CODEX_3D_LOGO, LOGO_TRANSPARENT);
    return;
  }

  if (agent.name == "Claude Code") {
    const int x = 233 - THREE_D_LOGO_SIZE / 2;
    const int y = 68 + bob;
    drawTransparentRgb565Image(x, y, THREE_D_LOGO_SIZE, THREE_D_LOGO_SIZE, CLAUDE_3D_LOGO, LOGO_TRANSPARENT);
    return;
  }

  pushRgb565Image(233 - AGENT_LOGO_SIZE / 2, 96 + bob, AGENT_LOGO_SIZE, AGENT_LOGO_SIZE, logo);
}

void pushRgb565Image(int32_t x, int32_t y, int32_t w, int32_t h, const uint16_t* image) {
  bool previousSwap = drawTarget->getSwapBytes();
  drawTarget->setSwapBytes(true);
  drawTarget->pushImage(x, y, w, h, image);
  drawTarget->setSwapBytes(previousSwap);
}

void drawTransparentRgb565Image(int32_t x, int32_t y, int32_t w, int32_t h, const uint16_t* image, uint16_t transparent) {
  drawTarget->startWrite();
  for (int32_t row = 0; row < h; row++) {
    for (int32_t col = 0; col < w; col++) {
      uint16_t color = pgm_read_word(&image[row * w + col]);
      if (!isTransparentLogoPixel(color, transparent)) {
        drawTarget->writePixel(x + col, y + row, color);
      }
    }
  }
  drawTarget->endWrite();
}

bool isTransparentLogoPixel(uint16_t color, uint16_t transparent) {
  const uint16_t swappedTransparent = (transparent << 8) | (transparent >> 8);
  return color == transparent || color == swappedTransparent || color == 0x0000;
}

void drawUsageRow(int32_t y, const String& label, int percent, const String& timeText, uint16_t accent) {
  drawTarget->setTextDatum(middle_left);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(label, 82, y);
  drawSegmentBar(151, y - 7, percent, accent);
  drawTarget->setTextDatum(middle_right);
  drawTarget->setFont(&fonts::Font4);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(percentText(percent), 318, y);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(timeText, 386, y);
}

void drawSegmentBar(int32_t x, int32_t y, int percent, uint16_t accent) {
  const int segments = 12;
  const int lit = map(constrain(percent, 0, 100), 0, 100, 0, segments);
  for (int i = 0; i < segments; i++) {
    uint16_t color = i < lit ? accent : 0x39E7;
    drawTarget->fillRoundRect(x + i * 9, y, 6, 13, 3, color);
  }
}

void drawUsageBars(const AgentStatus& agent, uint16_t accent) {
  drawVerticalUsageBar(122, 236, agent.primaryUsageLabel, agent.primaryUsagePercent, agent.primaryUsageReset, accent);
  drawVerticalUsageBar(196, 236, agent.secondaryUsageLabel, agent.secondaryUsagePercent, agent.secondaryUsageReset, accent);
  drawVerticalUsageBar(270, 236, "usage", agent.tokenPercent, durationText(agent.tokenPercent), accent);
  drawVerticalUsageBar(344, 236, "weekly", agent.progress, durationText(max(0, agent.progress) * 4), accent);
}

void drawTokenUsageBars(const AgentStatus& agent, uint16_t accent) {
  drawVerticalUsageBar(178, 240, "usage", agent.tokenPercent, durationText(agent.tokenPercent), accent);
  drawVerticalUsageBar(288, 240, "weekly", agent.progress, durationText(max(0, agent.progress) * 4), accent);
}

void drawVerticalUsageBar(int32_t centerX, int32_t topY, const String& label, int percent, const String& timeText, uint16_t accent) {
  const int segments = 10;
  const int segmentW = 14;
  const int segmentH = 5;
  const int gap = 2;
  const int totalH = segments * segmentH + (segments - 1) * gap;
  const int lit = map(constrain(percent, 0, 100), 0, 100, 0, segments);
  const int barX = centerX - segmentW / 2;
  const int barY = topY + 25;

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(percentText(percent), centerX, topY);

  for (int i = 0; i < segments; i++) {
    const int segmentY = barY + totalH - segmentH - i * (segmentH + gap);
    const uint16_t color = i < lit ? accent : 0x39E7;
    drawTarget->fillRoundRect(barX, segmentY, segmentW, segmentH, 2, color);
  }

  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(truncateText(label, 6), centerX, barY + totalH + 16);
  drawTarget->setTextColor(COLOR_MUTED, COLOR_BG);
  drawTarget->drawString(truncateText(timeText, 6), centerX, barY + totalH + 35);
}

void drawUsageTrends(const AgentStatus& agent, uint16_t accent) {
  drawTokenTrendChart(145, 210, "usage", agent.usageTotal, agent.hasUsageTotal, agent.usageTrend, agent.usageTrendCount, COLOR_CYAN);
  drawTokenTrendChart(321, 210, "weekly", agent.weeklyTotal, agent.hasWeeklyTotal, agent.weeklyTrend, agent.weeklyTrendCount, COLOR_VIOLET);
}

void drawTokenTrendChart(int32_t centerX, int32_t topY, const String& label, uint64_t total, bool hasTotal, const uint64_t* points, size_t count, uint16_t color) {
  const int32_t chartW = 122;
  const int32_t graphH = 48;
  const int32_t left = centerX - chartW / 2;
  const int32_t graphTop = topY + 38;
  const int32_t baseline = graphTop + graphH;

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(color, COLOR_BG);
  drawTarget->drawString(label, centerX, topY);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(compactTokenCount(total, hasTotal), centerX, topY + 20);

  drawTarget->drawLine(left, baseline, left + chartW, baseline, 0x39E7);
  drawTarget->drawLine(left, graphTop + graphH / 2, left + chartW, graphTop + graphH / 2, 0x2104);

  uint64_t maxValue = 0;
  for (size_t i = 0; i < count; i++) {
    if (points[i] > maxValue) maxValue = points[i];
  }

  if (count == 0 || maxValue == 0) {
    drawTarget->drawLine(left, graphTop + graphH / 2, left + chartW, graphTop + graphH / 2, COLOR_MUTED);
    return;
  }

  int32_t previousX = left;
  int32_t previousY = baseline;
  const size_t pulseIndex = count > 0 ? (millis() / DASHBOARD_ANIMATION_MS) % count : 0;
  for (size_t i = 0; i < count; i++) {
    const int32_t x = count <= 1 ? centerX : left + (chartW * int32_t(i)) / int32_t(count - 1);
    const double ratio = double(points[i]) / double(maxValue);
    const int32_t y = baseline - int32_t(ratio * graphH);
    if (i > 0) {
      drawTarget->drawLine(previousX, previousY, x, y, color);
      drawTarget->drawLine(previousX, previousY + 1, x, y + 1, color);
    }
    drawTarget->fillCircle(x, y, 2, color);
    if (i == pulseIndex) {
      drawTarget->drawCircle(x, y, 5, COLOR_TEXT);
      drawTarget->fillCircle(x, y, 3, color);
    }
    previousX = x;
    previousY = y;
  }
}

void drawUsageWindowFooter(const AgentStatus& agent, uint16_t accent) {
  drawUsageWindowFooterItem(326, agent.primaryUsageLabel, agent.primaryUsagePercent, agent.primaryUsageReset, COLOR_BLUE);
  drawUsageWindowFooterItem(350, agent.secondaryUsageLabel, agent.secondaryUsagePercent, agent.secondaryUsageReset, COLOR_YELLOW);
}

void drawUsageWindowFooterItem(int32_t y, const String& label, int percent, const String& resetText, uint16_t color) {
  const int segments = 10;
  const int lit = percent < 0 ? 0 : map(constrain(percent, 0, 100), 0, 100, 0, segments);
  const int pulse = percent < 0 ? -1 : (millis() / DASHBOARD_ANIMATION_MS) % segments;

  drawTarget->setTextDatum(middle_center);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(color, COLOR_BG);
  drawTarget->drawString(label, 118, y);

  const int segmentStartX = 145;
  const int segmentTop = y - 6;
  for (int i = 0; i < segments; i++) {
    const uint16_t segmentColor = i < lit
      ? (i == pulse ? COLOR_TEXT : color)
      : (i == pulse ? COLOR_MUTED : 0xC638);
    drawTarget->fillRoundRect(segmentStartX + i * 8, segmentTop, 5, 12, 3, segmentColor);
  }

  drawTarget->setFont(&fonts::Font4);
  drawTarget->setTextColor(percent < 0 ? COLOR_MUTED : COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(percentText(percent), 282, y);
  drawTarget->setFont(&fonts::Font2);
  drawTarget->setTextColor(COLOR_TEXT, COLOR_BG);
  drawTarget->drawString(truncateText(resetText, 6), 350, y);
}

void drawVoiceIndicator(uint16_t accent) {
  const int32_t cx = 233;
  const int32_t cy = 190;
  const int phase = (millis() / VOICE_ANIMATION_MS) % 8;
  const bool waking = voiceStatus.state == "speaking";
  const bool thinking = voiceStatus.state == "thinking";

  if (voiceStatus.state == "ready") {
    drawCheckGlyph(cx, cy, COLOR_GREEN);
  } else if (voiceStatus.state == "error") {
    drawMicGlyph(cx, cy, COLOR_MUTED);
  } else if (waking || voiceStatus.state == "recording" || voiceStatus.state == "transcribing" || thinking) {
    const uint16_t progressColor = voiceStatus.state == "thinking" ? COLOR_VIOLET : COLOR_YELLOW;
    const uint16_t waveColor = (thinking || voiceStatus.state == "transcribing") ? progressColor : accent;
    drawMicGlyph(cx, cy, COLOR_MUTED);
    for (int i = 0; i < 5; i++) {
      const int height = 6 + ((phase + i * 2) % 5) * 3;
      const int barX = cx - 14 + i * 7;
      const int barY = cy + 9 - height / 2;
      drawTarget->fillRoundRect(barX, barY, 4, height, 2, waveColor);
    }
  } else {
    drawMicGlyph(cx, cy, COLOR_MUTED);
  }

  if (voiceStatus.state == "thinking" && (voiceStatus.assistantThinkingStartedAt > 0 || voiceStatus.hasAssistantElapsed)) {
    drawTarget->setTextDatum(middle_center);
    drawTarget->setFont(&fonts::Font2);
    drawTarget->setTextColor(COLOR_VIOLET, COLOR_BG);
    drawTarget->drawString("AI " + assistantLatencyText(), cx, cy + 42);
  } else if ((voiceStatus.state == "transcribing" && voiceStatus.asrTranscribingStartedAt > 0) || voiceStatus.hasAsrLatency) {
    drawTarget->setTextDatum(middle_center);
    drawTarget->setFont(&fonts::Font2);
    drawTarget->setTextColor(voiceStatus.state == "transcribing" ? COLOR_YELLOW : COLOR_MUTED, COLOR_BG);
    drawTarget->drawString("ASR " + voiceLatencyText(), cx, cy + 42);
  }
}

void drawMicGlyph(int32_t centerX, int32_t centerY, uint16_t color) {
  drawTarget->fillRoundRect(centerX - 7, centerY - 12, 14, 22, 7, color);
  drawTarget->fillRoundRect(centerX - 4, centerY - 9, 8, 16, 4, COLOR_BG);
  drawTarget->drawArc(centerX, centerY + 3, 15, 13, 20, 160, color);
  drawTarget->drawLine(centerX, centerY + 15, centerX, centerY + 21, color);
  drawTarget->drawLine(centerX - 9, centerY + 21, centerX + 9, centerY + 21, color);
}

void drawCheckGlyph(int32_t centerX, int32_t centerY, uint16_t color) {
  drawTarget->drawLine(centerX - 13, centerY, centerX - 4, centerY + 10, color);
  drawTarget->drawLine(centerX - 4, centerY + 10, centerX + 14, centerY - 12, color);
  drawTarget->drawLine(centerX - 13, centerY + 1, centerX - 4, centerY + 11, color);
  drawTarget->drawLine(centerX - 4, centerY + 11, centerX + 14, centerY - 11, color);
}

String voiceLatencyText() {
  uint32_t elapsedMs = voiceStatus.asrLatencyMs;
  if (voiceStatus.state == "transcribing" && voiceStatus.asrTranscribingStartedAt > 0) {
    elapsedMs = static_cast<uint32_t>(millis() - voiceStatus.asrTranscribingStartedAt);
  }

  if (elapsedMs < 1000) {
    return String(elapsedMs) + "ms";
  }

  if (elapsedMs < 10000) {
    return String(double(elapsedMs) / 1000.0, 1) + "s";
  }

  return String(elapsedMs / 1000) + "s";
}

String assistantLatencyText() {
  uint32_t elapsedMs = voiceStatus.assistantElapsedMs;
  if (voiceStatus.state == "thinking" && voiceStatus.assistantThinkingStartedAt > 0) {
    elapsedMs += static_cast<uint32_t>(millis() - voiceStatus.assistantThinkingStartedAt);
  }

  if (elapsedMs < 1000) {
    return String(elapsedMs) + "ms";
  }

  if (elapsedMs < 10000) {
    return String(double(elapsedMs) / 1000.0, 1) + "s";
  }

  return String(elapsedMs / 1000) + "s";
}

void drawCenteredText(const String& text, int32_t y, const lgfx::IFont* font, uint16_t color) {
  drawTarget->setTextDatum(middle_center);
  drawTarget->setTextColor(color, COLOR_BG);
  drawTarget->setFont(font);
  drawTarget->drawString(text, 233, y);
}

String shortTime(const String& isoTime) {
  if (isoTime.length() >= 19) {
    return isoTime.substring(11, 19);
  }
  return isoTime;
}

String percentText(int value) {
  if (value < 0) return "--";
  return String(constrain(value, 0, 100)) + "%";
}

String truncateText(const String& text, size_t maxLength) {
  if (text.length() <= maxLength) return text;
  if (maxLength <= 1) return text.substring(0, maxLength);
  return text.substring(0, maxLength - 1) + ".";
}

String durationText(int percent) {
  if (percent <= 0) return "--";
  int minutes = max(1, percent / 3);
  if (minutes < 60) return String(minutes) + "m";
  return String(minutes / 60) + "h" + String(minutes % 60) + "m";
}

String compactTokenCount(uint64_t value, bool available) {
  if (!available) return "--";
  if (value >= 1000000000ULL) {
    return String(double(value) / 1000000000.0, value >= 10000000000ULL ? 0 : 1) + "B";
  }
  if (value >= 1000000ULL) {
    return String(double(value) / 1000000.0, value >= 10000000ULL ? 0 : 1) + "M";
  }
  if (value >= 1000ULL) {
    return String(double(value) / 1000.0, value >= 10000ULL ? 0 : 1) + "K";
  }
  return String(value);
}

String maskedWifiPassword() {
  if (typedWifiPassword.length() == 0) return "_";
  String masked = "";
  const size_t visibleLength = min<size_t>(typedWifiPassword.length(), 18);
  for (size_t i = 0; i < visibleLength; i++) {
    masked += "*";
  }
  if (typedWifiPassword.length() > visibleLength) {
    masked = "..." + masked;
  }
  return masked;
}

String passwordInputText() {
  if (typedWifiPassword.length() == 0) {
    return "tap keys below";
  }
  return maskedWifiPassword();
}

char currentKeyboardChar() {
  return KEYBOARD_CHARS[keyboardIndex % strlen(KEYBOARD_CHARS)];
}

const char* currentKeyboardPage() {
  return KEYBOARD_PAGES[keyboardPage % KEYBOARD_PAGE_COUNT];
}

size_t currentKeyboardPageLength() {
  return strlen(currentKeyboardPage());
}

int keyboardKeyAt(int32_t x, int32_t y) {
  const size_t keyCount = currentKeyboardPageLength();
  for (size_t index = 0; index < keyCount; index++) {
    const int32_t row = index / KEYBOARD_COLS;
    const int32_t col = index % KEYBOARD_COLS;
    const int32_t keyX = KEYBOARD_LEFT + col * (KEYBOARD_KEY_WIDTH + KEYBOARD_KEY_GAP);
    const int32_t keyY = KEYBOARD_TOP + row * (KEYBOARD_KEY_HEIGHT + KEYBOARD_KEY_GAP);
    if (pointInRect(
      x,
      y,
      keyX - KEYBOARD_TOUCH_PADDING,
      keyY - KEYBOARD_TOUCH_PADDING,
      KEYBOARD_KEY_WIDTH + KEYBOARD_TOUCH_PADDING * 2,
      KEYBOARD_KEY_HEIGHT + KEYBOARD_TOUCH_PADDING * 2
    )) {
      return int(index);
    }
  }
  return -1;
}

bool pointInRect(int32_t px, int32_t py, int32_t x, int32_t y, int32_t w, int32_t h) {
  return px >= x && px < x + w && py >= y && py < y + h;
}

bool isWiFiSetupMode() {
  return uiMode == UiMode::WifiList || uiMode == UiMode::WifiKeyboard;
}

uint16_t colorForPercent(int value) {
  if (value >= 85) return COLOR_RED;
  if (value >= 65) return COLOR_YELLOW;
  return COLOR_GREEN;
}

const AgentStatus& activeAgent() {
  return activeAgentIndex == 0 ? codex : claude;
}

String agentKey(int agentIndex) {
  return agentIndex == 0 ? "codex" : "claude";
}

int agentIndexForKey(const String& agent) {
  return agent == "claude" ? 1 : 0;
}
