// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import type { CoderProfileConfig } from "@t3tools/coder-cli/configStore";

import { CODER_GATEWAY_HOST } from "./http.ts";

/** Ports past the requested one a server forward tries before reporting that none is free. */
export const MAX_LOCAL_PORT_CANDIDATES = 100;

/** Whether `port` can be bound on the loopback address `coder port-forward` listens on. */
function loopbackPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = NodeHttp.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: CODER_GATEWAY_HOST, exclusive: true }, () =>
      probe.close(() => resolve(true)),
    );
  });
}

/**
 * The requested port, or the next one, that no saved TCP forward uses and nothing on this
 * computer holds. Null when none of the candidates is free.
 */
export async function findFreeForwardPort(
  requested: number,
  config: CoderProfileConfig,
): Promise<number | null> {
  const saved = new Set(
    (config.portForwards ?? [])
      .filter((portForward) => portForward.protocol === "tcp")
      .map((portForward) => portForward.localPort),
  );
  const last = Math.min(65_535, requested + MAX_LOCAL_PORT_CANDIDATES);
  for (let port = requested; port <= last; port += 1) {
    if (!saved.has(port) && (await loopbackPortIsFree(port))) return port;
  }
  return null;
}
