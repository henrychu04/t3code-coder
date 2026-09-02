// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, match, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as NodeFS from "node:fs/promises";
import { createRequire } from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "node:test";

import { CODER_HELPER_INFO_METHOD, CODER_HELPER_PROTOCOL_VERSION } from "@t3tools/coder-cli/rpc";

import { buildCoderHelper, currentHelperNativeTarget } from "./build.ts";

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

async function verifyBundledPtyResize(outputDirectory: string, cwd: string): Promise<void> {
  if (process.platform === "win32") return;

  const requireFromBundle = createRequire(NodePath.join(outputDirectory, "index.mjs"));
  const nodePty = requireFromBundle("node-pty") as typeof import("node-pty");
  const pty = nodePty.spawn("/bin/sh", [], {
    cwd,
    cols: 80,
    rows: 24,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  let output = "";
  let didExit = false;
  const onData = pty.onData((data) => {
    output += data;
  });

  try {
    pty.resize(132, 44);
    pty.write("printf '__T3_SIZE__'; stty size; printf '__T3_END__\\n'; exit\n");
    await Promise.race([
      new Promise<void>((resolve) => {
        pty.onExit(() => {
          didExit = true;
          resolve();
        });
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("Bundled node-pty resize smoke test timed out.")),
          5_000,
        ).unref();
      }),
    ]);
    match(output, /__T3_SIZE__44 132\r?\n__T3_END__/u);
  } finally {
    onData.dispose();
    if (!didExit) pty.kill();
  }
}

it("runs the bundled ESM helper under Node", async () => {
  const testRoot = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-bundle-"));
  const outputDirectory = NodePath.join(testRoot, "workspace-helper");
  await buildCoderHelper(outputDirectory, currentHelperNativeTarget());

  const expectedNodePtyPrebuild = `${process.platform}-${process.arch}`;
  deepStrictEqual(
    await NodeFS.readdir(NodePath.join(outputDirectory, "node_modules", "node-pty", "prebuilds")),
    [expectedNodePtyPrebuild],
  );
  await NodeFS.access(
    NodePath.join(
      outputDirectory,
      "node_modules",
      "node-pty",
      "prebuilds",
      expectedNodePtyPrebuild,
      process.platform === "win32" ? "conpty.node" : "pty.node",
    ),
  );
  await verifyBundledPtyResize(outputDirectory, testRoot);

  const helper = spawn(process.execPath, [NodePath.join(outputDirectory, "index.mjs")], {
    env: {
      ...process.env,
      HOME: testRoot,
      T3_CODER_HOME: NodePath.join(testRoot, ".t3-coder"),
      T3_CODER_CWD: testRoot,
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  helper.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exit = once(helper, "exit");

  try {
    helper.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "bundle-smoke",
        tag: CODER_HELPER_INFO_METHOD,
        payload: { protocolVersion: CODER_HELPER_PROTOCOL_VERSION },
        headers: [],
      })}\n`,
    );

    const response = (await Promise.race([
      readNdjsonLine(helper.stdout),
      exit.then(([exitCode, signal]) => {
        throw new Error(
          `Bundled helper exited before responding (code=${String(exitCode)}, signal=${String(signal)}).\n${stderr}`,
        );
      }),
    ])) as {
      readonly exit?: {
        readonly _tag?: string;
        readonly value?: { readonly protocolVersion?: number };
      };
    };
    strictEqual(response.exit?._tag, "Success");
    deepStrictEqual(response.exit?.value?.protocolVersion, CODER_HELPER_PROTOCOL_VERSION);

    helper.stdin.end();
    const [exitCode] = await exit;
    strictEqual(exitCode, 130);
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) {
      helper.kill();
      await exit;
    }
    await NodeFS.rm(testRoot, { recursive: true, force: true });
  }
});
