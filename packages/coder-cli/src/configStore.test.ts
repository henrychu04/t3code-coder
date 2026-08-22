// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, throws } from "node:assert";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  emptyCoderProfileConfig,
  loadCoderProfileConfig,
  parseCoderProfileConfig,
  saveCoderProfileConfig,
} from "./configStore.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFS.rm(directory, { recursive: true, force: true })),
  );
});

describe("Coder profile config store", () => {
  it("returns an empty config when no file exists", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-config-"));
    tempDirectories.push(directory);
    deepStrictEqual(
      await loadCoderProfileConfig(NodePath.join(directory, "missing.json")),
      emptyCoderProfileConfig(),
    );
  });

  it("round-trips non-secret deployment and workspace metadata", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-config-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "nested", "config.json");
    const config = {
      version: 1,
      deployments: [
        {
          id: "goldman-us",
          name: "Goldman US",
          url: "https://coder.example.gs.com",
        },
      ],
      workspaces: [
        {
          id: "equities",
          name: "Equities",
          deploymentId: "goldman-us",
          workspace: "equities-dev",
          workspaceRoot: "/workspace/equities",
        },
      ],
    } as const;

    await saveCoderProfileConfig(configPath, config);
    deepStrictEqual(await loadCoderProfileConfig(configPath), config);
  });

  it("rejects workspace references to missing deployments", () => {
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [],
        workspaces: [
          {
            id: "equities",
            name: "Equities",
            deploymentId: "missing",
            workspace: "dev",
            workspaceRoot: "/workspace/equities",
          },
        ],
      }),
    );
  });

  it("does not accept malformed executable values", () => {
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [
          { id: "goldman", name: "Goldman", url: "https://coder.example", executable: 42 },
        ],
        workspaces: [],
      }),
    );
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example",
            executable: String.raw`C:\Windows\System32\cmd.exe`,
          },
        ],
        workspaces: [],
      }),
    );
  });

  it("rejects secret-like fields instead of persisting them", () => {
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example",
            token: "must-not-be-stored",
          },
        ],
        workspaces: [],
      }),
    );
  });

  it("rejects token-like URL queries and option-shaped workspace targets", () => {
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example?token=must-not-be-stored",
          },
        ],
        workspaces: [],
      }),
    );
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example" }],
        workspaces: [
          {
            id: "project",
            name: "Project",
            deploymentId: "goldman",
            workspace: "--url=attacker.example",
            workspaceRoot: "/workspace/project",
          },
        ],
      }),
    );
  });
});
