// @effect-diagnostics nodeBuiltinImport:off
import { match, rejects, strictEqual } from "node:assert";
import { existsSync } from "node:fs";
import * as NodeFS from "node:fs/promises";
import { after, describe, it } from "node:test";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  hashCoderHelperBundle,
  installCoderHelper,
  runProcess,
  uploadCoderComposerAttachment,
} from "./transfer.ts";

const temporaryDirectories: string[] = [];
after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => NodeFS.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  // A realpath keeps macOS's /var → /private/var symlink out of path comparisons.
  const directory = await NodeFS.realpath(
    await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  temporaryDirectories.push(directory);
  return directory;
}

/** Debian's `sh` is dash; macOS ships it too, so the remote scripts run under it when present. */
const remoteShell = existsSync("/bin/dash") ? "/bin/dash" : "/bin/sh";

/**
 * A fake `coder` that runs the command after `--` the way the workspace would, with `HOME` set
 * to a scratch directory. `stdinFilter` may rewrite the transferred bytes to simulate damage.
 */
async function fakeCoder(options?: { readonly stdinFilter?: string; readonly log?: string }) {
  const directory = await temporaryDirectory("t3-coder-transfer-");
  const home = NodePath.join(directory, "home");
  await NodeFS.mkdir(NodePath.join(home, ".t3-coder", "bin"), { recursive: true });
  await NodeFS.mkdir(NodePath.join(home, ".t3-coder", "attachments"), { recursive: true });
  const executable = NodePath.join(directory, "coder");
  await NodeFS.writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const remote = args.slice(args.indexOf("--") + 1).join(" ");',
      ...(options?.log
        ? [`fs.appendFileSync(${JSON.stringify(options.log)}, remote + "\\n");`]
        : []),
      // The workspace's shell evaluates the joined arguments after `--`, as Coder sends them.
      `const child = spawn("/bin/sh", ["-c", remote.replace(/^sh -l /, ${JSON.stringify(`${remoteShell} `)})], {`,
      `  env: { ...process.env, HOME: ${JSON.stringify(home)} },`,
      '  stdio: ["pipe", "inherit", "inherit"],',
      "});",
      `const filter = ${options?.stdinFilter ?? "(chunk) => chunk"};`,
      'process.stdin.on("data", (chunk) => child.stdin.write(filter(chunk)));',
      'process.stdin.on("end", () => child.stdin.end());',
      'child.stdin.on("error", () => undefined);',
      'child.on("exit", (code) => process.exit(code ?? 1));',
    ].join("\n"),
    { mode: 0o700 },
  );
  return {
    home,
    deployment: {
      id: "deployment",
      name: "Deployment",
      url: "https://coder.example.test",
      executable,
    },
    workspace: {
      id: "workspace",
      name: "Workspace",
      deploymentId: "deployment",
      workspace: "owner/ws",
    },
  };
}

async function writeBundle(directory: string): Promise<string> {
  const bundle = NodePath.join(directory, "workspace-helper");
  const deep = NodePath.join(bundle, "node_modules", "a".repeat(60), "b".repeat(60));
  await NodeFS.mkdir(deep, { recursive: true });
  await NodeFS.writeFile(NodePath.join(bundle, "index.mjs"), "export {};\n");
  await NodeFS.writeFile(NodePath.join(bundle, "empty.txt"), "");
  // Every byte value, including PTY control characters, must arrive unchanged.
  await NodeFS.writeFile(
    NodePath.join(deep, "pty.node"),
    Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256)),
  );
  return bundle;
}

async function remoteEntries(home: string, directory: string): Promise<string[]> {
  return (await NodeFS.readdir(NodePath.join(home, ".t3-coder", directory))).toSorted();
}

describe("Coder CLI transfers", () => {
  it("hashes a helper bundle by relative path and contents", async () => {
    const directory = await temporaryDirectory("t3-coder-bundle-");
    await NodeFS.mkdir(NodePath.join(directory, "runtime"));
    await NodeFS.writeFile(NodePath.join(directory, "index.mjs"), "export {};\n");
    await NodeFS.writeFile(NodePath.join(directory, "runtime", "pty.node"), "binary");
    const first = await hashCoderHelperBundle(directory);
    match(first, /^[a-f0-9]{64}$/u);
    strictEqual(await hashCoderHelperBundle(directory), first);
    await NodeFS.writeFile(NodePath.join(directory, "runtime", "pty.node"), "binarx");
    const changed = await hashCoderHelperBundle(directory);
    strictEqual(changed === first, false);
    await NodeFS.rename(
      NodePath.join(directory, "runtime", "pty.node"),
      NodePath.join(directory, "runtime", "pty2.node"),
    );
    strictEqual((await hashCoderHelperBundle(directory)) === changed, false);
  });

  it("streams the helper bundle over coder ssh and records its verified hash", async () => {
    const coder = await fakeCoder();
    const bundle = await writeBundle(NodePath.dirname(coder.home));
    const installed = NodePath.join(coder.home, ".t3-coder", "bin", "workspace-helper");
    await NodeFS.mkdir(installed);
    await NodeFS.writeFile(NodePath.join(installed, "stale.mjs"), "old");

    await Effect.runPromise(installCoderHelper({ ...coder, helperBundlePath: bundle }));

    const hash = await hashCoderHelperBundle(bundle);
    strictEqual(
      await NodeFS.readFile(NodePath.join(installed, ".t3-bundle-sha256"), "utf8"),
      `${hash}\n`,
    );
    await NodeFS.rm(NodePath.join(installed, ".t3-bundle-sha256"));
    strictEqual(await hashCoderHelperBundle(installed), hash);
    strictEqual((await NodeFS.stat(NodePath.join(installed, "index.mjs"))).mode & 0o777, 0o700);
    strictEqual(existsSync(NodePath.join(installed, "stale.mjs")), false);
    strictEqual((await remoteEntries(coder.home, "bin")).join(","), "workspace-helper");
  });

  it("rejects a damaged helper transfer and removes the partial copy", async () => {
    const coder = await fakeCoder({
      // Flips one byte inside pty.node's contents, which start 2,048 bytes into the archive.
      stdinFilter:
        "(chunk) => { const copy = Buffer.from(chunk); if (copy.length > 2100) copy[2100] ^= 1; return copy; }",
    });
    const bundle = await writeBundle(NodePath.dirname(coder.home));

    await rejects(
      Effect.runPromise(installCoderHelper({ ...coder, helperBundlePath: bundle })),
      /Coder helper transfer failed/u,
    );
    strictEqual((await remoteEntries(coder.home, "bin")).length, 0);
  });

  it("uploads a composer attachment under a generated pending name", async () => {
    const coder = await fakeCoder();
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256));

    const path = await Effect.runPromise(
      uploadCoderComposerAttachment({ ...coder, bytes, extension: "png" }),
    );

    const attachments = NodePath.join(coder.home, ".t3-coder", "attachments");
    match(path, /\/\.t3-coder\/attachments\/pending-[0-9a-f-]{36}-png\.png$/u);
    strictEqual(NodePath.dirname(path), attachments);
    strictEqual((await NodeFS.readFile(path)).equals(bytes), true);
    strictEqual((await NodeFS.stat(path)).mode & 0o777, 0o600);
    strictEqual((await remoteEntries(coder.home, "attachments")).length, 1);
  });

  it("removes a truncated attachment transfer", async () => {
    const coder = await fakeCoder({ stdinFilter: "(chunk) => chunk.subarray(1)" });

    await rejects(
      Effect.runPromise(
        uploadCoderComposerAttachment({ ...coder, bytes: Buffer.from("abcdef"), extension: "txt" }),
      ),
      /Coder attachment transfer failed/u,
    );
    strictEqual((await remoteEntries(coder.home, "attachments")).length, 0);
  });

  it("rejects a composer attachment extension before spawning any process", async () => {
    for (const extension of ["../x", "pdf;rm", "", "UPPER", "elevenchars"]) {
      await rejects(
        Effect.runPromise(
          uploadCoderComposerAttachment({
            deployment: {
              id: "deployment",
              name: "Deployment",
              url: "https://coder.example.test",
              executable: "/nonexistent/coder",
            },
            workspace: {
              id: "workspace",
              name: "Workspace",
              deploymentId: "deployment",
              workspace: "owner/workspace",
            },
            bytes: Buffer.from("x"),
            extension,
          }),
        ),
        /Invalid attachment extension/u,
      );
    }
  });

  it("writes stdin only after the remote ready line", async () => {
    const output = await Effect.runPromise(
      runProcess(
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              "let early = false;",
              'process.stdin.on("data", () => { early = true; });',
              "setTimeout(() => {",
              "  if (early) process.exit(2);",
              '  process.stdin.removeAllListeners("data");',
              "  let received = 0;",
              '  process.stdin.on("data", (chunk) => { received += chunk.length; });',
              '  process.stdin.on("end", () => { process.stdout.write(`received ${received}\\n`); });',
              '  process.stdout.write("banner\\nREADY\\n");',
              "}, 200);",
            ].join("\n"),
          ],
        },
        "Test transfer",
        5_000,
        50,
        { readySentinel: "READY", chunks: [Buffer.alloc(3), Buffer.alloc(4)] },
      ),
    );
    match(output, /received 7/u);
  });

  it("waits for a timed-out child to exit after escalating termination", async () => {
    const startedAt = Date.now();

    await rejects(
      Effect.runPromise(
        runProcess(
          {
            executable: process.execPath,
            args: [
              "-e",
              'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1_000);',
            ],
          },
          "Test process",
          200,
          50,
        ),
      ),
      /Test process timed out/u,
    );

    strictEqual(Date.now() - startedAt >= 240, true);
  });

  it("cleans up the remote temporary paths when interrupted", async () => {
    const directory = await temporaryDirectory("t3-coder-transfer-interrupt-");
    const log = NodePath.join(directory, "commands");
    const executable = NodePath.join(directory, "coder");
    await NodeFS.writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.at(-1) + "\\n");`,
        // The transfer never becomes ready; cleanup commands exit immediately.
        'if (process.argv.at(-1).includes("head -c")) setInterval(() => undefined, 1_000);',
      ].join("\n"),
      { mode: 0o700 },
    );
    const bundle = await writeBundle(directory);
    const fiber = Effect.runFork(
      installCoderHelper({
        deployment: {
          id: "deployment",
          name: "Deployment",
          url: "https://coder.example.test",
          executable,
        },
        workspace: {
          id: "workspace",
          name: "Workspace",
          deploymentId: "deployment",
          workspace: "owner/ws",
        },
        helperBundlePath: bundle,
      }),
    );
    for (let attempt = 0; attempt < 500 && !existsSync(log); attempt += 1) await delay(10);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const commands = (await NodeFS.readFile(log, "utf8")).trim().split("\n");
    strictEqual(commands.length, 2);
    match(commands[1]!, /rm -rf "\$HOME\/\.t3-coder\/bin\/workspace-helper\.tmp\.[0-9a-f-]{36}"/u);
    match(commands[1]!, /workspace-helper\.tmp\.[0-9a-f-]{36}\.tar"/u);
  });
});
