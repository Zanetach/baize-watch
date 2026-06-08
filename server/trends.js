export function bucketTokenTrend(events, { nowMs = Date.now(), windowMs, bucketCount = 12 } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isInteger(bucketCount) || bucketCount <= 0) {
    return [];
  }

  const points = Array.from({ length: bucketCount }, () => 0);
  const startMs = nowMs - windowMs;
  const bucketMs = windowMs / bucketCount;

  for (const event of events || []) {
    const timestampMs = numberOrNull(event?.timestampMs);
    const tokens = numberOrNull(event?.tokens);
    if (timestampMs === null || tokens === null || tokens < 0) continue;
    if (timestampMs < startMs || timestampMs > nowMs) continue;

    const index = Math.min(bucketCount - 1, Math.floor((timestampMs - startMs) / bucketMs));
    points[index] += Math.round(tokens);
  }

  return points;
}

export function normalizeTokenTrend(trend, fallbackTotal = null, maxPoints = 12) {
  const source = Array.isArray(trend) ? { points: trend } : trend;
  const total = numberOrNull(source?.total) ?? numberOrNull(fallbackTotal);
  let points = Array.isArray(source?.points)
    ? source.points.map(numberOrNull).filter((value) => value !== null && value >= 0)
    : [];

  if (points.length > maxPoints) {
    points = points.slice(points.length - maxPoints);
  }

  if (!points.length && total !== null) {
    points = [total];
  } else if (total !== null && total > 0 && points.every((value) => value === 0)) {
    points = [...points.slice(0, -1), total];
  }

  return {
    total,
    points: points.map((value) => Math.round(value))
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
