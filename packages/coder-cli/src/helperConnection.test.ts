// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import * as NodeFS from "node:fs/promises";
import { describe, it } from "node:test";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { connectCoderHelper, isExpectedCoderHelperExit } from "./helperConnection.ts";
import { CODER_HELPER_INFO_METHOD, CODER_HELPER_PROTOCOL_VERSION } from "./rpc.ts";

const helperPath = fileURLToPath(new URL("../../../apps/coder-helper/src/bin.ts", import.meta.url));

describe("Coder helper connection", () => {
  it("negotiates with the foreground helper and closes with the pipe", async () => {
    const helperHome = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-helper-"));
    const connection = await connectCoderHelper(
      {
        executable: process.execPath,
        args: [helperPath],
      },
      { environment: { ...process.env, T3_CODER_HOME: helperHome } },
    );
    strictEqual(connection.info.protocolVersion, CODER_HELPER_PROTOCOL_VERSION);
    strictEqual(connection.info.platform, process.platform);
    strictEqual(connection.info.architecture, process.arch);

    const rpcResponse = new Promise<unknown>((resolve) => {
      const unsubscribe = connection.onRpcMessage((message) => {
        unsubscribe();
        resolve(message);
      });
    });
    connection.sendRpc({
      _tag: "Request",
      id: "second-info",
      tag: CODER_HELPER_INFO_METHOD,
      payload: { protocolVersion: CODER_HELPER_PROTOCOL_VERSION },
      headers: [],
    });
    deepStrictEqual(await rpcResponse, {
      _tag: "Exit",
      requestId: "second-info",
      exit: {
        _tag: "Success",
        value: {
          protocolVersion: CODER_HELPER_PROTOCOL_VERSION,
          platform: process.platform,
          architecture: process.arch,
        },
      },
    });

    connection.close();
    strictEqual((await connection.closed).expected, true);
    await NodeFS.rm(helperHome, { recursive: true, force: true });
  });

  it("treats Effect's stdin interruption exit as a normal disconnect", () => {
    strictEqual(isExpectedCoderHelperExit(130, null, false), true);
    strictEqual(isExpectedCoderHelperExit(1, null, false), false);
  });

  it("reports a missing Coder executable during connection", async () => {
    await rejects(
      connectCoderHelper(
        { executable: "t3-coder-missing-executable-for-test", args: [] },
        { negotiationTimeoutMs: 1_000 },
      ),
      /ENOENT/,
    );
  });
});
