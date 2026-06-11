import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiscoveryResponse,
  chooseLanAddressForRemote
} from "./discovery.js";

test("discovery chooses the LAN address on the same subnet as the device", () => {
  const address = chooseLanAddressForRemote("192.168.5.88", [
    "198.18.0.1",
    "192.168.5.36",
    "10.0.0.8"
  ]);

  assert.equal(address, "192.168.5.36");
});

test("discovery response includes the current device websocket url", () => {
  const response = buildDiscoveryResponse({
    remoteAddress: "192.168.5.88",
    addresses: ["198.18.0.1", "192.168.5.36"],
    port: 8787
  });

  assert.deepEqual(response, {
    type: "baize_watch",
    wsUrl: "ws://192.168.5.36:8787/device"
  });
});
