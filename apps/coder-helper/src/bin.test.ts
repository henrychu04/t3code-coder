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
import { ORCHESTRATION_WS_METHODS, ProviderInstanceId, WS_METHODS } from "@t3tools/contracts";

function makeNdjsonReader(stream: NodeJS.ReadableStream): () => Promise<unknown> {
  const queued: Array<unknown> = [];
  const waiting: Array<{
    readonly resolve: (value: unknown) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  let buffered = "";

  const fail = (cause: unknown) => {
    for (const waiter of waiting.splice(0)) waiter.reject(cause);
  };
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const value = JSON.parse(line) as unknown;
        const waiter = waiting.shift();
        if (waiter) waiter.resolve(value);
        else queued.push(value);
      } catch (cause) {
        fail(cause);
      }
    }
  });
  stream.on("error", fail);

  return () => {
    const value = queued.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
}

describe("Coder foreground helper", () => {
  it("negotiates Effect RPC over stdio and exits when stdin closes", async () => {
    const helperHome = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-helper-"));
    const helper = spawn(process.execPath, [fileURLToPath(new URL("./bin.ts", import.meta.url))], {
      env: {
        ...process.env,
        HOME: helperHome,
        T3_CODER_HOME: NodePath.join(helperHome, ".t3-coder"),
        T3_CODER_CWD: helperHome,
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const readResponse = makeNdjsonReader(helper.stdout);

    helper.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "integration-1",
        tag: CODER_HELPER_INFO_METHOD,
        payload: { protocolVersion: CODER_HELPER_PROTOCOL_VERSION },
        headers: [],
      })}\n`,
    );

    deepStrictEqual(await readResponse(), {
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

    helper.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "server-config",
        tag: WS_METHODS.serverGetConfig,
        payload: {},
        headers: [],
      })}\n`,
    );
    const configEnvelope = (await readResponse()) as {
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

    helper.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "provider-slash-commands",
        tag: WS_METHODS.providerListSlashCommands,
        payload: {
          instanceId: ProviderInstanceId.make("missing-provider"),
          cwd: helperHome,
        },
        headers: [],
      })}\n`,
    );
    deepStrictEqual(await readResponse(), {
      _tag: "Exit",
      requestId: "provider-slash-commands",
      exit: { _tag: "Success", value: [] },
    });

    helper.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "shell-snapshot",
        tag: ORCHESTRATION_WS_METHODS.subscribeShell,
        payload: {},
        headers: [],
      })}\n`,
    );
    const shellEnvelope = (await readResponse()) as {
      readonly _tag?: string;
      readonly requestId?: string;
      readonly values?: ReadonlyArray<{
        readonly kind?: string;
        readonly snapshot?: {
          readonly projects?: ReadonlyArray<unknown>;
          readonly threads?: ReadonlyArray<unknown>;
        };
      }>;
    };
    strictEqual(shellEnvelope._tag, "Chunk");
    strictEqual(shellEnvelope.requestId, "shell-snapshot");
    strictEqual(shellEnvelope.values?.[0]?.kind, "snapshot");
    deepStrictEqual(shellEnvelope.values?.[0]?.snapshot?.projects, []);
    deepStrictEqual(shellEnvelope.values?.[0]?.snapshot?.threads, []);

    helper.stdin.write(`${JSON.stringify({ _tag: "Ack", requestId: "shell-snapshot" })}\n`);
    const synchronizedEnvelope = (await readResponse()) as {
      readonly _tag?: string;
      readonly requestId?: string;
      readonly values?: ReadonlyArray<{ readonly kind?: string }>;
    };
    strictEqual(synchronizedEnvelope._tag, "Chunk");
    strictEqual(synchronizedEnvelope.requestId, "shell-snapshot");
    strictEqual(synchronizedEnvelope.values?.[0]?.kind, "synchronized");

    helper.stdin.end();
    const [exitCode] = await once(helper, "exit");
    strictEqual(exitCode, 130);
    await NodeFS.rm(helperHome, { recursive: true, force: true });
  });
});
