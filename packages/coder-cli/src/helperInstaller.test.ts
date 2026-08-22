// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, rejects } from "node:assert";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, it } from "node:test";

import { installCoderHelper } from "./helperInstaller.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFS.rm(directory, { recursive: true, force: true })),
  );
});

describe("Coder helper installer", () => {
  it("frames the helper length so the remote command does not need stdin EOF", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-helper-install-"));
    tempDirectories.push(directory);
    const bundlePath = NodePath.join(directory, "workspace-helper");
    const installedPath = NodePath.join(directory, "installed-helper");
    const bundle = Buffer.from("#!/usr/bin/env node\nconsole.log('helper');\n");
    await NodeFS.writeFile(bundlePath, bundle);

    await installCoderHelper(
      {
        executable: process.execPath,
        args: [
          "-e",
          [
            'const fs = require("node:fs");',
            "let buffered = Buffer.alloc(0);",
            'process.stdin.on("data", (chunk) => {',
            "  buffered = Buffer.concat([buffered, chunk]);",
            "  const newline = buffered.indexOf(10);",
            "  if (newline < 0) return;",
            '  const size = Number(buffered.subarray(0, newline).toString("ascii"));',
            "  const payload = buffered.subarray(newline + 1);",
            "  if (payload.length < size) return;",
            "  fs.writeFileSync(process.argv[1], payload.subarray(0, size));",
            "  process.exit(0);",
            "});",
          ].join("\n"),
          installedPath,
        ],
      },
      bundlePath,
    );

    deepStrictEqual(await NodeFS.readFile(installedPath), bundle);
  });

  it("rejects cleanly when Coder exits during a large helper upload", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-helper-install-"));
    tempDirectories.push(directory);
    const bundlePath = NodePath.join(directory, "workspace-helper");
    await NodeFS.writeFile(bundlePath, Buffer.alloc(4 * 1024 * 1024, 1));

    await rejects(
      installCoderHelper({ executable: "/usr/bin/false", args: [] }, bundlePath),
      /Coder helper installation failed/,
    );
  });

  it("times out when Coder stops consuming the helper upload", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-helper-install-"));
    tempDirectories.push(directory);
    const bundlePath = NodePath.join(directory, "workspace-helper");
    await NodeFS.writeFile(bundlePath, "helper");

    await rejects(
      installCoderHelper(
        { executable: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] },
        bundlePath,
        { timeoutMs: 25 },
      ),
      /Timed out while installing the Coder workspace helper/,
    );
  });
});
