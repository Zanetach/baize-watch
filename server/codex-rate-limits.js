export function isBetterCodexRateLimitEntry(candidate, current = null) {
  if (!candidate?.rateLimits) return false;
  if (!current?.rateLimits) return true;

  const candidateRank = codexRateLimitPriority(candidate.rateLimits);
  const currentRank = codexRateLimitPriority(current.rateLimits);
  if (candidateRank !== currentRank) return candidateRank > currentRank;

  return numberOrZero(candidate.timestampMs) > numberOrZero(current.timestampMs);
}

export function codexRateLimitPriority(rateLimits) {
  const limitId = String(rateLimits?.limit_id || "").toLowerCase();
  if (limitId === "codex") return 3;
  if (rateLimits?.plan_type) return 2;
  if (limitId.startsWith("codex_")) return 1;
  return rateLimits ? 1 : 0;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
