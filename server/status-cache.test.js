import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlightTtlCache } from "./status-cache.js";

test("single-flight ttl cache coalesces concurrent refreshes", async () => {
  let calls = 0;
  let now = 1000;
  const cache = createSingleFlightTtlCache({
    ttlMs: 5000,
    now: () => now,
    load: async () => {
      calls++;
      return { value: calls };
    }
  });

  const [first, second] = await Promise.all([cache.get(), cache.get()]);

  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(second, { value: 1 });
  assert.equal(calls, 1);

  now += 2000;
  assert.deepEqual(await cache.get(), { value: 1 });
  assert.equal(calls, 1);

  now += 4000;
  assert.deepEqual(await cache.get(), { value: 2 });
  assert.equal(calls, 2);
});

test("single-flight ttl cache keeps the last good value when refresh fails", async () => {
  let calls = 0;
  let now = 1000;
  const cache = createSingleFlightTtlCache({
    ttlMs: 1000,
    now: () => now,
    load: async () => {
      calls++;
      if (calls === 2) throw new Error("temporary failure");
      return { value: calls };
    }
  });

  assert.deepEqual(await cache.get(), { value: 1 });
  now += 1500;
  assert.deepEqual(await cache.get(), { value: 1 });
  assert.equal(calls, 2);
});
