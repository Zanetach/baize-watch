export function createSingleFlightTtlCache({
  ttlMs,
  load,
  now = () => Date.now()
} = {}) {
  if (typeof load !== "function") {
    throw new TypeError("load function is required");
  }

  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : 0;
  let cachedValue;
  let hasValue = false;
  let expiresAt = 0;
  let pending = null;

  async function refresh() {
    if (!pending) {
      pending = Promise.resolve()
        .then(load)
        .then((value) => {
          cachedValue = value;
          hasValue = true;
          expiresAt = now() + ttl;
          return value;
        })
        .catch((caught) => {
          if (hasValue) return cachedValue;
          throw caught;
        })
        .finally(() => {
          pending = null;
        });
    }

    return pending;
  }

  return {
    get({ force = false } = {}) {
      if (!force && hasValue && now() < expiresAt) {
        return Promise.resolve(cachedValue);
      }
      return refresh();
    },
    clear() {
      hasValue = false;
      cachedValue = undefined;
      expiresAt = 0;
      pending = null;
    }
  };
}
