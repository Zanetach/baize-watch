export function buildCodexUsageWindows(rateLimits, options = {}) {
  if (!rateLimits) return [];
  return [
    buildCodexUsageWindow("primary", rateLimits.primary, options),
    buildCodexUsageWindow("secondary", rateLimits.secondary, options)
  ].filter(Boolean);
}

export function buildCodexUsageWindow(kind, limit, options = {}) {
  const usedPercent = numberOrNull(limit?.used_percent);
  if (usedPercent === null) return null;

  const windowMinutes = numberOrNull(limit?.window_minutes);
  const resetsAt = numberOrNull(limit?.resets_at);

  return {
    kind,
    label: formatWindowLabel(windowMinutes, kind),
    windowMinutes,
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    resetAt: timestampFromSeconds(resetsAt),
    resetText: formatResetTextForWindow(resetsAt, { ...options, kind, windowMinutes })
  };
}

export function formatResetTextForWindow(seconds, {
  kind = "",
  windowMinutes = null,
  timeZone = localTimeZone()
} = {}) {
  const resetSeconds = numberOrNull(seconds);
  if (resetSeconds === null) return "--";

  const resetMs = resetSeconds * 1000;
  if (kind === "primary" || windowMinutes === 300) {
    return formatLocalTime(resetMs, timeZone);
  }

  return formatLocalDate(resetMs, timeZone);
}

export function formatWindowLabel(windowMinutes, kind) {
  const minutes = numberOrNull(windowMinutes);
  if (!minutes) return kind === "secondary" ? "1w" : "5h";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatLocalTime(ms, timeZone) {
  const parts = dateParts(ms, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return `${parts.hour}:${parts.minute}`;
}

function formatLocalDate(ms, timeZone) {
  const parts = dateParts(ms, timeZone, {
    month: "numeric",
    day: "numeric"
  });
  return `${parts.month}/${parts.day}`;
}

function dateParts(ms, timeZone, options) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
  return Object.fromEntries(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
}

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

function timestampFromSeconds(value) {
  const seconds = numberOrNull(value);
  if (seconds === null) return null;
  return new Date(seconds * 1000).toISOString();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  if (value === null || value === undefined) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
