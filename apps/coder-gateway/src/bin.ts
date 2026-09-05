import { readFile } from "node:fs/promises";
// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as NodeOS from "node:os";
import { fileURLToPath } from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { buildBrowserOpenInvocation } from "@t3tools/coder-cli/command";
import { resolveCoderConfigPath } from "@t3tools/coder-cli/configPath";
import { makeLocalCoderGateway } from "./server.ts";

const main = Effect.gen(function* () {
  const gateway = yield* makeLocalCoderGateway({
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
  const version = yield* Effect.promise(() =>
    readFile(
      new URL("../../coder-helper/dist/workspace-helper/build-info.json", import.meta.url),
      "utf8",
    )
      .then((raw) => (JSON.parse(raw) as { version: string }).version)
      .catch(() => "development"),
  );
  yield* Effect.sync(() =>
    process.stdout.write(`T3 Coder ${version} listening on ${gateway.url}\n`),
  );

  if (process.argv.includes("--open-browser")) {
    yield* Effect.sync(() => {
      const browser = buildBrowserOpenInvocation(process.platform, gateway.url);
      const browserProcess = spawn(browser.executable, browser.args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      browserProcess.once("error", () => undefined);
      browserProcess.unref();
    });
  }

  return yield* Effect.never;
}).pipe(Effect.scoped);

NodeRuntime.runMain(main);
