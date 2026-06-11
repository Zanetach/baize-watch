import dgram from "node:dgram";
import os from "node:os";

export const DISCOVERY_REQUEST = "baize-watch-discover-v1";
export const DISCOVERY_RESPONSE_TYPE = "baize_watch";

export function getLocalAddresses(networkInterfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

export function chooseLanAddressForRemote(remoteAddress, addresses = getLocalAddresses()) {
  const remotePrefix = ipv4Prefix(remoteAddress);
  if (remotePrefix) {
    const sameSubnet = addresses.find((address) => ipv4Prefix(address) === remotePrefix);
    if (sameSubnet) return sameSubnet;
  }
  return addresses[0] || "127.0.0.1";
}

export function buildDiscoveryResponse({ remoteAddress, addresses = getLocalAddresses(), port }) {
  const address = chooseLanAddressForRemote(remoteAddress, addresses);
  return {
    type: DISCOVERY_RESPONSE_TYPE,
    wsUrl: `ws://${address}:${port}/device`
  };
}

export function createDiscoveryResponder({
  discoveryPort = 8788,
  monitorPort = 8787,
  getAddresses = getLocalAddresses,
  socket = dgram.createSocket("udp4"),
  logger = console
} = {}) {
  socket.on("message", (message, remote) => {
    if (message.toString("utf8").trim() !== DISCOVERY_REQUEST) return;

    const response = buildDiscoveryResponse({
      remoteAddress: remote.address,
      addresses: getAddresses(),
      port: monitorPort
    });
    const payload = Buffer.from(JSON.stringify(response));
    socket.send(payload, remote.port, remote.address, (error) => {
      if (error) {
        logger.warn?.(`[${new Date().toISOString()}] discovery_reply_failed ${error.message}`);
      }
    });
  });

  socket.on("error", (error) => {
    logger.warn?.(`[${new Date().toISOString()}] discovery_socket_error ${error.message}`);
  });

  return {
    start() {
      socket.bind(discoveryPort, "0.0.0.0", () => {
        try {
          socket.setBroadcast(true);
        } catch {
          // Broadcast support can vary by interface; unicast replies still work.
        }
        logger.log?.(`Baize Watch discovery listening on UDP ${discoveryPort}`);
      });
    },
    close() {
      socket.close();
    }
  };
}

function ipv4Prefix(address) {
  const parts = String(address || "").split(".");
  if (parts.length !== 4) return "";
  return parts.slice(0, 3).join(".");
}
