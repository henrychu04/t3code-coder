// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CODER_HELPER_INFO_METHOD, CODER_HELPER_PROTOCOL_VERSION } from "@t3tools/coder-cli/rpc";
import { WS_METHODS } from "@t3tools/contracts";

function readNdjsonLine(stream: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      try {
        stream.removeListener("data", onData);
        resolve(JSON.parse(buffered.slice(0, newline)) as unknown);
      } catch (cause) {
        reject(cause);
      }
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

describe("Coder foreground helper", () => {
  it("negotiates Effect RPC over stdio and exits when stdin closes", async () => {
    const helperHome = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-helper-"));
    const helper = spawn(process.execPath, [fileURLToPath(new URL("./bin.ts", import.meta.url))], {
      env: { ...process.env, T3_CODER_HOME: helperHome },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const response = readNdjsonLine(helper.stdout);

    helper.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "integration-1",
        tag: CODER_HELPER_INFO_METHOD,
        payload: { protocolVersion: CODER_HELPER_PROTOCOL_VERSION },
        headers: [],
      })}\n`,
    );

    deepStrictEqual(await response, {
      _tag: "Exit",
      requestId: "integration-1",
      exit: {
        _tag: "Success",
        value: {
          protocolVersion: CODER_HELPER_PROTOCOL_VERSION,
          platform: process.platform,
          architecture: process.arch,
        },
      },
    });

    const configResponse = readNdjsonLine(helper.stdout);
    helper.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "server-config",
        tag: WS_METHODS.serverGetConfig,
        payload: {},
        headers: [],
      })}\n`,
    );
    const configEnvelope = (await configResponse) as {
      readonly exit?: {
        readonly _tag?: string;
        readonly value?: { readonly providers?: ReadonlyArray<{ readonly driver?: string }> };
      };
    };
    strictEqual(configEnvelope.exit?._tag, "Success");
    deepStrictEqual(
      configEnvelope.exit?.value?.providers?.map((provider) => provider.driver),
      ["claudeAgent"],
    );

    helper.stdin.end();
    const [exitCode] = await once(helper, "exit");
    strictEqual(exitCode, 130);
    await NodeFS.rm(helperHome, { recursive: true, force: true });
  });
});
