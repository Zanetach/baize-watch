#pragma once

// Copy this file to firmware/include/secrets.h and edit these values.
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Fallback only. Current firmware discovers the desktop monitor on UDP 8788 first.
// Do not use localhost; on Baize Watch, localhost means the ESP32 itself.
#define MONITOR_WS_URL "ws://192.168.1.10:8787/device"
