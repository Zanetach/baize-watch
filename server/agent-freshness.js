export function agentFreshness(updatedAt, {
  nowMs = Date.now(),
  staleAfterMs = 2 * 60 * 60 * 1000
} = {}) {
  const normalizedUpdatedAt = typeof updatedAt === "string" && updatedAt.trim() ? updatedAt : null;
  if (!normalizedUpdatedAt) {
    return {
      updatedAt: null,
      ageMs: null,
      ageMinutes: null,
      stale: true
    };
  }

  const updatedMs = Date.parse(normalizedUpdatedAt);
  if (!Number.isFinite(updatedMs)) {
    return {
      updatedAt: normalizedUpdatedAt,
      ageMs: null,
      ageMinutes: null,
      stale: true
    };
  }

  const ageMs = Math.max(0, nowMs - updatedMs);
  return {
    updatedAt: normalizedUpdatedAt,
    ageMs,
    ageMinutes: Math.round(ageMs / 60000),
    stale: ageMs > staleAfterMs
  };
}
