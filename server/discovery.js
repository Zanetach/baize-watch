import dgram from "node:dgram";
import os from "node:os";

export const DISCOVERY_REQUEST = "baize-watch-discover-v1";
export const DISCOVERY_RESPONSE_TYPE = "baize_watch";
export const LEGACY_DISCOVERY_REQUEST = "stopwatch-monitor-discover-v1";
export const LEGACY_DISCOVERY_RESPONSE_TYPE = "stopwatch_monitor";

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

export function buildDiscoveryResponse({
  remoteAddress,
  addresses = getLocalAddresses(),
  port,
  type = DISCOVERY_RESPONSE_TYPE
}) {
  const address = chooseLanAddressForRemote(remoteAddress, addresses);
  return {
    type,
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
    const request = message.toString("utf8").trim();
    const responseType = responseTypeForRequest(request);
    if (!responseType) return;

    const response = buildDiscoveryResponse({
      remoteAddress: remote.address,
      addresses: getAddresses(),
      port: monitorPort,
      type: responseType
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

function responseTypeForRequest(request) {
  if (request === DISCOVERY_REQUEST) return DISCOVERY_RESPONSE_TYPE;
  if (request === LEGACY_DISCOVERY_REQUEST) return LEGACY_DISCOVERY_RESPONSE_TYPE;
  return "";
}

function ipv4Prefix(address) {
  const parts = String(address || "").split(".");
  if (parts.length !== 4) return "";
  return parts.slice(0, 3).join(".");
}
