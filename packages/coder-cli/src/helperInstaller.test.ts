// @effect-diagnostics nodeBuiltinImport:off
import { rejects } from "node:assert";
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
