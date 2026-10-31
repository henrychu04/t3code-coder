// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

const MIN_SAVED_GATEWAY_PORT = 1024;
const MAX_SAVED_GATEWAY_PORT = 65_535;

export async function readSavedGatewayPort(portPath: string): Promise<number | null> {
  try {
    const raw = (await NodeFS.readFile(portPath, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    const port = Number(raw);
    return port >= MIN_SAVED_GATEWAY_PORT && port <= MAX_SAVED_GATEWAY_PORT ? port : null;
  } catch {
    return null;
  }
}

export async function saveGatewayPort(portPath: string, port: number): Promise<void> {
  try {
    await NodeFS.mkdir(NodePath.dirname(portPath), { recursive: true });
    await NodeFS.writeFile(portPath, `${port}\n`, "utf8");
  } catch {
    // The next start falls back to an ephemeral port.
  }
}
