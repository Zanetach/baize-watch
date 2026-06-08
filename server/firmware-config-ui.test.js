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
  assert.match(firmwareSource, /StopWatch-Setup/);
  assert.match(firmwareSource, /startConfigPortal/);
  assert.match(firmwareSource, /WiFi\.localIP\(\)/);
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

test("firmware uses the StopWatch touch screen for Wi-Fi selection and password entry", () => {
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
  assert.match(firmwareSource, /voiceStatus\.state == "error"/);
  assert.match(firmwareSource, /COLOR_RING_DIM/);
  assert.match(firmwareSource, /COLOR_YELLOW/);
  assert.match(firmwareSource, /COLOR_RED/);
  assert.doesNotMatch(firmwareSource, /Outer arcs mimic the reference face/);
  assert.doesNotMatch(firmwareSource, /drawArc\(233, 233, 206, 199, -215, -35, accent\)/);
});

test("dashboard logo uses a nonzero animation offset instead of a static logo draw", () => {
  assert.match(firmwareSource, /animatedLogoBob/);
  assert.match(firmwareSource, /drawAnimatedLogo\(agent, logo, animatedLogoBob\(\)\)/);
  assert.match(firmwareSource, /LOGO_ANIMATION_MS/);
  assert.doesNotMatch(firmwareSource, /drawAnimatedLogo\(agent, logo, 0\)/);
});

test("README documents config screen controls", () => {
  assert.match(readme, /Configuration Screen/);
  assert.match(readme, /Long-press either programmable button/);
  assert.match(readme, /Left button moves selection/);
  assert.match(readme, /Right button runs the selected action/);
  assert.match(readme, /StopWatch-Setup/);
  assert.match(readme, /select a scanned Wi-Fi network/);
  assert.match(readme, /enter the password/);
  assert.match(readme, /on-device Wi-Fi setup/);
  assert.match(readme, /Left button cycles/);
  assert.match(readme, /Long-press right connects/);
  assert.match(readme, /Tap a Wi-Fi name/);
  assert.match(readme, /Tap keyboard characters/);
});
