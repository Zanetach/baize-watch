export function buildCodexUsageWindows(rateLimits, options = {}) {
  if (!rateLimits) return [];
  return [
    buildCodexUsageWindow("primary", rateLimits.primary, options),
    buildCodexUsageWindow("secondary", rateLimits.secondary, options)
  ].filter(Boolean);
}

export function buildClaudeUsageWindows(rateLimits, options = {}) {
  if (!rateLimits) return [];
  return [
    buildPercentUsageWindow("primary", {
      label: "5h",
      windowMinutes: 300,
      usedPercent: rateLimits.five_hour?.used_percentage,
      resetsAt: rateLimits.five_hour?.resets_at
    }, options),
    buildPercentUsageWindow("secondary", {
      label: "7d",
      windowMinutes: 10080,
      usedPercent: rateLimits.seven_day?.used_percentage,
      resetsAt: rateLimits.seven_day?.resets_at
    }, options)
  ].filter(Boolean);
}

export function buildRollingUsageWindows({
  primaryUsed,
  primaryLimit,
  primaryWindowMinutes = 300,
  primaryLabel = null,
  secondaryUsed,
  secondaryLimit,
  secondaryWindowMinutes = 10080,
  secondaryLabel = "7d",
  resetText = "roll"
} = {}) {
  return [
    buildRollingUsageWindow("primary", {
      used: primaryUsed,
      limit: primaryLimit,
      windowMinutes: primaryWindowMinutes,
      label: primaryLabel,
      resetText
    }),
    buildRollingUsageWindow("secondary", {
      used: secondaryUsed,
      limit: secondaryLimit,
      windowMinutes: secondaryWindowMinutes,
      label: secondaryLabel,
      resetText
    })
  ].filter(Boolean);
}

export function buildCodexUsageWindow(kind, limit, options = {}) {
  const usedPercent = numberOrNull(limit?.used_percent);
  if (usedPercent === null) return null;

  const windowMinutes = numberOrNull(limit?.window_minutes);
  const resetsAt = numberOrNull(limit?.resets_at);
  return buildPercentUsageWindow(kind, {
    label: null,
    windowMinutes,
    usedPercent,
    resetsAt
  }, options);
}

function buildPercentUsageWindow(kind, {
  label,
  windowMinutes,
  usedPercent,
  resetsAt
} = {}, options = {}) {
  const percent = numberOrNull(usedPercent);
  if (percent === null) return null;

  return {
    kind,
    label: label || formatWindowLabel(windowMinutes, kind),
    windowMinutes,
    usedPercent: clampPercent(percent),
    remainingPercent: clampPercent(100 - percent),
    resetAt: timestampFromSeconds(resetsAt),
    resetText: formatResetTextForWindow(resetsAt, { ...options, kind, windowMinutes })
  };
}

function buildRollingUsageWindow(kind, {
  used,
  limit,
  windowMinutes,
  label,
  resetText
} = {}) {
  const usedPercent = percentFromTokens(used, limit);
  if (usedPercent === null) return null;

  return {
    kind,
    label: label || formatWindowLabel(windowMinutes, kind),
    windowMinutes: numberOrNull(windowMinutes),
    usedPercent,
    remainingPercent: usedPercent,
    resetAt: null,
    resetText
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

function percentFromTokens(used, limit) {
  const tokenCount = numberOrNull(used);
  const tokenLimit = numberOrNull(limit);
  if (tokenCount === null || !tokenLimit) return null;
  return clampPercent((tokenCount / tokenLimit) * 100);
}

function clampPercent(value) {
  if (value === null || value === undefined) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
