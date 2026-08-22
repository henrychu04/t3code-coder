// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as NodeOS from "node:os";
import { fileURLToPath } from "node:url";

import { buildBrowserOpenInvocation } from "@t3tools/coder-cli/command";
import { resolveCoderConfigPath } from "@t3tools/coder-cli/configPath";
import { startLocalCoderGateway } from "./server.ts";

const gateway = await startLocalCoderGateway({
  configPath: resolveCoderConfigPath({
    platform: process.platform,
    homeDirectory: NodeOS.homedir(),
    environment: process.env,
  }),
  staticDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  helperBundlePath: fileURLToPath(
    new URL("../../coder-helper/dist/workspace-helper", import.meta.url),
  ),
});
process.stdout.write(`T3 Coder listening on ${gateway.url}\n`);

if (process.argv.includes("--open-browser")) {
  const browser = buildBrowserOpenInvocation(process.platform, gateway.url);
  const browserProcess = spawn(browser.executable, browser.args, {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  browserProcess.once("error", () => undefined);
  browserProcess.unref();
}

async function shutdown(): Promise<void> {
  await gateway.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
