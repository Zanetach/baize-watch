# M5Stack StopWatch Desktop Monitor

This project turns an M5Stack StopWatch into a small desktop status monitor.

The first version has two parts:

- `server/`: a local Node.js service that collects desktop status and broadcasts it over WebSocket.
- `firmware/`: PlatformIO firmware for the M5Stack StopWatch that renders the status on the round AMOLED display.

## What It Shows

- Codex online state and token usage trend
- Claude Code online state and token usage trend
- Codex and Claude Code official-style color logos on the browser preview and StopWatch screen
- CPU usage
- Memory usage
- Mac battery percentage and charging state
- Git working tree change count for the monitor repo
- Alerts for high CPU, high memory, low battery, dirty Git state, and high agent token usage

## Start The Desktop Service

Run it with the package CLI:

```bash
stopwatch-monitor start
```

Install it as a macOS background service:

```bash
stopwatch-monitor install
```

The installer creates:

- `~/.stopwatch-monitor/env` for local runtime configuration
- `~/.stopwatch-monitor/agent-status.json` for optional manual agent overrides
- `~/Library/LaunchAgents/com.zane.stopwatch-monitor.plist` for background startup
- `~/.stopwatch-monitor/stopwatch-monitor.log` and `~/.stopwatch-monitor/stopwatch-monitor.err.log`

Manage the background service:

```bash
stopwatch-monitor status
stopwatch-monitor restart
stopwatch-monitor stop
stopwatch-monitor logs
stopwatch-monitor uninstall
```

For an npm/npx-style install after publishing:

```bash
npx stopwatch-desktop-monitor install
```

For local development from this repository:

Install dependencies:

```bash
npm install
```

Start the monitor:

```bash
npm start
```

Or run the CLI directly:

```bash
node bin/stopwatch-monitor.js start
```

The service prints URLs like:

```text
Browser preview: http://localhost:8787
Device WebSocket: ws://192.168.1.23:8787/device
```

Open the browser preview to verify the service locally. Use the `Device WebSocket` LAN URL in the firmware config. Do not use `localhost` on the StopWatch because it points to the device itself, not your Mac.

Optional environment variables:

```bash
MONITOR_PORT=8787
MONITOR_LABEL="Zane MBP"
MONITOR_GIT_REPO=/Users/zane/Documents/Github/stopwatch
MONITOR_INTERVAL_MS=1000
MONITOR_AGENT_STATUS_FILE=/Users/zane/Documents/Github/stopwatch/server/agent-status.json
MONITOR_CODEX_TOKEN_LIMIT=200000000
MONITOR_CODEX_SESSIONS_DIR=/Users/zane/.codex/sessions
MONITOR_CLAUDE_TOKEN_LIMIT=200000
MONITOR_CODEX_WEEKLY_TOKEN_LIMIT=5000000000
MONITOR_CLAUDE_WEEKLY_TOKEN_LIMIT=50000000
MONITOR_STT_PROVIDER=aliyun
MONITOR_STT_MODEL=gpt-4o-mini-transcribe
MONITOR_STT_LANGUAGE=zh
MONITOR_STT_TIMEOUT_MS=120000
MONITOR_ALIYUN_ASR_MODEL=fun-asr-realtime
MONITOR_ALIYUN_FALLBACK_MODEL=fun-asr-realtime
MONITOR_ALIYUN_ASR_PROTOCOL=auto
MONITOR_ALIYUN_ASR_URL=
MONITOR_ALIYUN_AUDIO_FORMAT=
MONITOR_ALIYUN_LANGUAGE_HINT=zh
MONITOR_ALIYUN_CHUNK_SIZE=3200
MONITOR_ALIYUN_CHUNK_INTERVAL_MS=100
DASHSCOPE_API_KEY=sk-...
OPENAI_API_KEY=sk-...
```

## Feed Codex And Claude Code Status

The monitor reads live local token data when it can:

- Codex: latest active thread `tokens_used` from `~/.codex/state_5.sqlite`
- Codex remaining usage: latest local `rate_limits` event from `~/.codex/sessions/**/*.jsonl`
- Claude Code: latest `message.usage` entry from `~/.claude/projects/**/*.jsonl`

It also combines that with lightweight local process detection. `server/agent-status.json` remains the explicit override path for task labels, progress, and any token value you want to set manually.

On the StopWatch face, `usage` and `weekly` are token-count trend charts rather than percentage bars. The `5h` and `1w` remaining windows are shown horizontally at the bottom with remaining percentage and reset text when Codex exposes that data locally. The compact face hides the agent name, time, battery line, and review count, using the logo and pager dots as the main identity cues.

## Voice Input

The StopWatch can record short Chinese voice prompts and paste the transcript into the currently focused Codex App, Codex CLI, or Claude Code input field on macOS.

Voice controls:

- Double-press the left button to start recording for Codex.
- Double-press the right button to start recording for Claude Code.
- Press either button while recording to stop and transcribe.
- After the transcript is pasted into the focused input field, press the right button to send Return.

The desktop service supports two speech-to-text providers:

- `aliyun`: uses Alibaba Cloud Model Studio DashScope real-time speech recognition over WebSocket and requires `DASHSCOPE_API_KEY`.
- `openai`: uses the OpenAI Audio Transcriptions API and requires `OPENAI_API_KEY`.

If neither `MONITOR_STT_PROVIDER` nor `OPENAI_API_KEY` is set, the service defaults to `aliyun`. Start the service with:

```bash
MONITOR_STT_PROVIDER=aliyun \
DASHSCOPE_API_KEY=sk-... \
npm start
```

The default Aliyun model is `fun-asr-realtime` with 16 kHz mono WAV input. You can override it with `MONITOR_ALIYUN_ASR_MODEL`, and set `MONITOR_ALIYUN_LANGUAGE_HINT=zh` only for models that support DashScope language hints. The service pastes text with macOS System Events, so Codex may need Accessibility permission for Terminal or Node.js the first time this runs.

To use Qwen3 ASR Flash, set the model to `qwen3-asr-flash-realtime`:

```bash
MONITOR_STT_PROVIDER=aliyun \
MONITOR_ALIYUN_ASR_MODEL=qwen3-asr-flash-realtime \
DASHSCOPE_API_KEY=sk-... \
npm start
```

When `MONITOR_ALIYUN_ASR_PROTOCOL=auto`, `qwen3-asr-*` models use the Qwen realtime endpoint `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` and PCM audio frames. Fun-ASR and Paraformer models use the DashScope inference endpoint `wss://dashscope.aliyuncs.com/api-ws/v1/inference` and WAV audio frames. If a Qwen realtime request fails, the service automatically retries once with `MONITOR_ALIYUN_FALLBACK_MODEL`, which defaults to `fun-asr-realtime`. Set `MONITOR_ALIYUN_FALLBACK_MODEL=off` to disable that fallback. Override `MONITOR_ALIYUN_ASR_URL` only when your API key belongs to a different region, such as Singapore.

Create a local status file:

```bash
cp server/agent-status.example.json server/agent-status.json
```

Edit it while a task is running:

```json
{
  "codex": {
    "online": true,
    "state": "running",
    "task": "Build StopWatch monitor",
    "progress": 45,
    "tokens": {
      "used": 42000,
      "limit": 200000
    },
    "trends": {
      "usage": {
        "total": 42000,
        "points": [1200, 1800, 2600, 4000, 5200, 7000, 8500, 9700, 13000, 18000, 25000, 42000]
      },
      "weekly": {
        "total": 188000,
        "points": [9000, 12000, 18000, 21000, 26000, 24000, 30000, 34000, 28000, 32000, 36000, 42000]
      }
    },
    "updatedAt": "2026-06-08T13:00:00.000Z"
  },
  "claude": {
    "online": true,
    "state": "reviewing",
    "task": "Check firmware UI",
    "progress": 70,
    "tokens": {
      "percent": 38
    },
    "updatedAt": "2026-06-08T13:05:00.000Z"
  }
}
```

Supported token inputs:

- `tokens.used` plus `tokens.limit`
- `tokens.percent`
- `tokenPercent`
- `trends.usage.total` plus `trends.usage.points`
- `trends.weekly.total` plus `trends.weekly.points`

Supported progress inputs:

- `progress`
- `progressPercent`

Claude Code has official monitoring hooks and exports token usage metrics such as `claude_code.token.usage`, but wiring that into this file depends on how you run Claude locally. Codex token/task progress also needs an explicit local exporter or status-line hook. This project keeps the hardware monitor decoupled from those tool-specific integrations.

## Configure Wi-Fi

The firmware first tries saved Wi-Fi credentials. If none are available, or if
connection fails, the device opens on-device Wi-Fi setup. You can complete this
without a phone, browser, or computer.

On-device Wi-Fi setup flow:

1. Long-press either programmable button to open the configuration screen.
2. Use the left button to select `Wi-Fi setup`.
3. Press the right button to start setup.
4. The StopWatch scans nearby Wi-Fi networks and shows them on the screen.
5. Tap a Wi-Fi name to select it.
6. Tap keyboard characters on the screen to enter the password.
7. Tap `a-m` / `n-z` / `A-M` / `N-Z` / `123` / `#+=` to switch keyboard pages.
8. Tap `Del` to delete the last character, then tap `OK` to connect.

The programmable buttons remain available as a fallback: left button cycles
through Wi-Fi names or password characters, right button chooses/adds, long-press
left deletes or goes back, and long-press right connects.

After setup, the StopWatch automatically requests an IP address with DHCP. When
Wi-Fi connects successfully, the screen shows the connected SSID and assigned IP
address, then reconnects to the desktop WebSocket service.

Browser setup remains available as a fallback through `Wi-Fi portal` in the
configuration screen. It starts the `StopWatch-Setup` hotspot; join it from a
phone or computer, open `http://192.168.4.1`, select a scanned Wi-Fi network,
enter the password, and connect.

For developer-only fallback config, copy the example secrets file:

```bash
cp firmware/include/secrets.example.h firmware/include/secrets.h
```

Edit `firmware/include/secrets.h`:

```cpp
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MONITOR_WS_URL "ws://192.168.1.23:8787/device"
```

The StopWatch and the Mac must be on the same network, and macOS must allow inbound connections to the Node.js process. Saved Wi-Fi credentials from the setup portal take priority over the fallback values in `secrets.h`.

## Configuration Screen

The existing Codex and Claude Code dashboard faces remain the default screens.
Long-press either programmable button to open the device configuration screen.

Configuration controls:

- Tap a menu item to run it directly.
- Left button moves selection.
- Right button runs the selected action.
- Long-press either programmable button exits the configuration screen.

The configuration screen shows the active Wi-Fi name, device IP, WebSocket URL,
server connection state, voice state, and latest desktop battery value. It also
provides actions for reconnecting the WebSocket server, opening on-device Wi-Fi
setup, opening the browser Wi-Fi portal, and returning to the dashboard.

## Logos

Logo source files are stored under `server/public/logos/`:

- `codex-color.svg`
- `claudecode-color.svg`
- `codex-color.png`
- `claudecode-color.png`

The browser preview serves these files at `/logos/codex-color.svg` and `/logos/claudecode-color.svg`. The firmware uses `firmware/include/agent_logos.h`, generated from the 48px PNG files as 40px RGB565 arrays.

If you replace either SVG, regenerate the PNG and firmware header:

```bash
rsvg-convert -w 48 -h 48 server/public/logos/codex-color.svg -o server/public/logos/codex-color.png
rsvg-convert -w 48 -h 48 server/public/logos/claudecode-color.svg -o server/public/logos/claudecode-color.png
python3 scripts/generate_logo_header.py
```

The logos remain trademarks of their respective owners. Keep them as product identifiers only; do not use them as this project's own brand.

## Build And Flash

Install PlatformIO if needed:

```bash
python3 -m pip install platformio
```

Build:

```bash
cd firmware
pio run
```

Flash:

```bash
pio run -t upload
```

Serial monitor:

```bash
pio device monitor
```

## Controls

- Press the left button to show the Codex face.
- Press the right button to show the Claude Code face.
- Double-press the left button to start recording for Codex.
- Double-press the right button to start recording for Claude Code.
- Press either button while recording to stop and transcribe.
- Press the right button when a transcript is ready to send Return.
- Long-press either programmable button to open or exit the configuration screen.
- In on-device Wi-Fi setup, Left button cycles Wi-Fi names or password characters.
- In on-device Wi-Fi setup, right chooses a Wi-Fi name or adds the selected password character.
- In password entry, long-press left deletes and Long-press right connects.

## Current Scope

This MVP stores Wi-Fi credentials through the ESP32 setup portal. The desktop
WebSocket URL still comes from firmware config.
