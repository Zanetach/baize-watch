<p align="center">
  <img src="docs/images/readme-hero.svg" alt="StopWatch Desktop Monitor hero image" width="100%">
</p>

# StopWatch Desktop Monitor

Turn an M5Stack StopWatch into a local desktop status monitor for Codex and Claude Code. The project ships a Node.js macOS service, a background-service installer, a browser preview, speech-to-text routing, and PlatformIO firmware for the round AMOLED screen.

The repository is intentionally local-first: the StopWatch talks to your Mac over a LAN WebSocket, the Mac reads local Codex / Claude Code usage signals when available, and voice prompts are pasted into the currently focused Codex App, Codex CLI, or Claude Code input field.

## What It Does

| Area | Current behavior |
|---|---|
| Device UI | Codex and Claude Code faces with official-style logos, token trend charts, 5h / 1w remaining windows, voice indicator, and subtle status ring |
| Desktop service | HTTP dashboard preview, `/status`, `/voice`, and WebSocket `/device` for the StopWatch firmware |
| Token data | Codex local SQLite/session JSONL readers, Claude Code project JSONL reader, plus optional manual override file |
| Voice input | StopWatch button recording, Aliyun DashScope realtime ASR, Qwen3 ASR Flash routing, Fun-ASR fallback, OpenAI transcription option |
| macOS integration | LaunchAgent background service, logs, local env file, System Events paste and Return |
| Firmware | ESP32-S3 / M5Stack StopWatch firmware built with PlatformIO and M5Unified |

## Architecture

<p align="center">
  <img src="docs/images/service-flow.svg" alt="StopWatch service flow diagram" width="100%">
</p>

## Quick Start

From GitHub, with access to this repository:

```bash
npx github:Zanetach/stopwatch install
```

From a local checkout:

```bash
git clone https://github.com/Zanetach/stopwatch.git
cd stopwatch
npm install
npm start
```

After the service starts, open:

```text
http://localhost:8787
```

The service prints one or more LAN WebSocket URLs:

```text
Device WebSocket: ws://192.168.1.23:8787/device
```

Use the LAN URL in firmware config. Do not use `localhost` on the StopWatch; on the device, `localhost` means the ESP32 itself.

## Background Service

The CLI can run the monitor in the foreground or install it as a macOS LaunchAgent.

```bash
stopwatch-monitor start
stopwatch-monitor install
stopwatch-monitor status
stopwatch-monitor restart
stopwatch-monitor stop
stopwatch-monitor logs
stopwatch-monitor uninstall
```

The installer writes:

| Path | Purpose |
|---|---|
| `~/.stopwatch-monitor/env` | Local runtime config and API keys |
| `~/.stopwatch-monitor/agent-status.json` | Optional manual Codex / Claude status overrides |
| `~/Library/LaunchAgents/com.zane.stopwatch-monitor.plist` | macOS background service |
| `~/.stopwatch-monitor/stopwatch-monitor.log` | Service stdout |
| `~/.stopwatch-monitor/stopwatch-monitor.err.log` | Service stderr |

The npm package is not published yet. After publishing, the intended install command is:

```bash
npx stopwatch-desktop-monitor install
```

## Voice Input

The StopWatch can record short Chinese prompts and send them to the active desktop input.

| Button action | Result |
|---|---|
| Double-press left | Start recording for Codex |
| Double-press right | Start recording for Claude Code |
| Press either button while recording | Stop and transcribe |
| Press right when transcript is ready | Send Return in the focused input |

Default Aliyun configuration:

```bash
MONITOR_STT_PROVIDER=aliyun
MONITOR_ALIYUN_ASR_MODEL=qwen3-asr-flash-realtime
MONITOR_ALIYUN_FALLBACK_MODEL=fun-asr-realtime
MONITOR_ALIYUN_ASR_PROTOCOL=auto
DASHSCOPE_API_KEY=sk-...
```

Provider behavior:

| Provider | Env | Notes |
|---|---|---|
| Aliyun DashScope | `DASHSCOPE_API_KEY` | Default provider when no OpenAI key is set |
| Qwen3 ASR Flash | `MONITOR_ALIYUN_ASR_MODEL=qwen3-asr-flash-realtime` | Uses DashScope realtime WebSocket and PCM frames |
| Fun-ASR realtime | `MONITOR_ALIYUN_FALLBACK_MODEL=fun-asr-realtime` | Automatic fallback for Qwen route failure |
| OpenAI | `MONITOR_STT_PROVIDER=openai`, `OPENAI_API_KEY` | Uses the Audio Transcriptions API |

The paste/send automation uses macOS System Events, so Terminal, your Node runtime, or the active host application may need Accessibility permission.

## Token And Task Data

The service builds each agent status from three sources:

1. Local automatic readers
2. Lightweight process detection
3. Optional manual override file

Automatic readers:

| Agent | Source |
|---|---|
| Codex | `~/.codex/state_5.sqlite` and `~/.codex/sessions/**/*.jsonl` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |

Manual overrides live in `server/agent-status.json` for development or `~/.stopwatch-monitor/agent-status.json` for the LaunchAgent install.

```bash
cp server/agent-status.example.json server/agent-status.json
```

Supported token fields:

| Field | Meaning |
|---|---|
| `tokens.used` + `tokens.limit` | Absolute usage and limit |
| `tokens.percent` | Direct percentage |
| `tokenPercent` | Direct percentage alias |
| `trends.usage.total` + `trends.usage.points` | Short-window token trend |
| `trends.weekly.total` + `trends.weekly.points` | Weekly token trend |

Supported progress fields: `progress` and `progressPercent`.

## Firmware Setup

Install PlatformIO if needed:

```bash
python3 -m pip install platformio
```

Build firmware:

```bash
cd firmware
python3 -m platformio run
```

Flash firmware:

```bash
python3 -m platformio run -t upload
```

Serial monitor:

```bash
python3 -m platformio device monitor
```

For developer fallback credentials:

```bash
cp firmware/include/secrets.example.h firmware/include/secrets.h
```

Edit:

```cpp
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MONITOR_WS_URL "ws://192.168.1.23:8787/device"
```

Saved Wi-Fi credentials from the on-device setup flow take priority over `secrets.h`.

## Configuration Screen

| Control | Action |
|---|---|
| Left button | Show Codex face |
| Right button | Show Claude Code face |
| Long-press either programmable button | Open or exit the configuration screen |
| Left button moves selection | Move through configuration actions |
| Right button runs the selected action | Run reconnect, Wi-Fi setup, Wi-Fi portal, or exit |
| Tap a Wi-Fi name | Select a scanned Wi-Fi network during on-device Wi-Fi setup |
| Tap keyboard characters | Enter the password |
| Left button cycles | Move through Wi-Fi names or password characters |
| Long-press right connects | Connect after password entry |

The configuration screen includes reconnect, on-device Wi-Fi setup, fallback Wi-Fi portal, server connection state, voice state, device IP, WebSocket URL, and battery status. The browser fallback starts the `StopWatch-Setup` access point; join it, select a scanned Wi-Fi network, enter the password, and let the device reconnect to the desktop WebSocket service.

## Browser Preview And API

| Route | Purpose |
|---|---|
| `/` | Browser dashboard preview |
| `/status` | Current desktop and agent status JSON |
| `/voice` | Voice controller state and active STT provider |
| `/device` | StopWatch WebSocket endpoint |
| `/client` | Browser/client WebSocket endpoint |
| `/logos/*` | Codex and Claude Code logo assets |

## Development

```bash
npm install
npm test
npm pack --dry-run
cd firmware && python3 -m platformio run
```

Useful local commands:

```bash
node bin/stopwatch-monitor.js --help
node bin/stopwatch-monitor.js start
curl http://localhost:8787/status
curl http://localhost:8787/voice
```

## Repository Layout

```text
bin/                         CLI entrypoint
server/                      Node.js monitor service, CLI installer, tests
server/public/logos/         Browser and firmware logo source assets
firmware/                    PlatformIO ESP32-S3 firmware
firmware/include/            Generated RGB565 logo header and secrets example
scripts/generate_logo_header.py
docs/images/                 README artwork
```

## Logo Assets

Logo source files are stored under `server/public/logos/`:

- `codex-color.svg`
- `claudecode-color.svg`
- `codex-color.png`
- `claudecode-color.png`

Regenerate firmware logo arrays after replacing source logos:

```bash
rsvg-convert -w 48 -h 48 server/public/logos/codex-color.svg -o server/public/logos/codex-color.png
rsvg-convert -w 48 -h 48 server/public/logos/claudecode-color.svg -o server/public/logos/claudecode-color.png
python3 scripts/generate_logo_header.py
```

The logos remain trademarks of their respective owners. Keep them as product identifiers only; do not use them as this project's own brand.

## Notes

- The desktop service must be reachable from the StopWatch over the same LAN.
- macOS may ask for firewall and Accessibility permissions.
- `firmware/include/secrets.h`, `.env.local`, and runtime status files are intentionally ignored.
- The Homebrew formula is not included yet; the current installer surface is the npm-style CLI plus LaunchAgent.
