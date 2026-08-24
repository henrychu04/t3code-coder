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
        },
      ],
    } as const;

    await saveCoderProfileConfig(configPath, config);
    deepStrictEqual(await loadCoderProfileConfig(configPath), config);
  });

  it("supports concurrent atomic saves without sharing a temporary path", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-config-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const configs = Array.from({ length: 20 }, (_, index) => ({
      version: 1 as const,
      deployments: [
        {
          id: `deployment-${index}`,
          name: `Deployment ${index}`,
          url: `https://coder-${index}.example.test`,
        },
      ],
      workspaces: [],
    }));

    await Promise.all(configs.map((config) => saveCoderProfileConfig(configPath, config)));

    const saved = await loadCoderProfileConfig(configPath);
    deepStrictEqual(
      configs.some((config) => JSON.stringify(config) === JSON.stringify(saved)),
      true,
    );
    deepStrictEqual(
      (await NodeFS.readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  });

  it("validates and round-trips workspace port forwards", () => {
    const base = {
      version: 1,
      deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example" }],
      workspaces: [
        {
          id: "equities",
          name: "Equities",
          deploymentId: "goldman",
          workspace: "henry/equities",
        },
      ],
    } as const;
    const config = {
      ...base,
      portForwards: [
        {
          id: "web",
          workspaceId: "equities",
          protocol: "tcp",
          localPort: 8080,
          remotePort: 3000,
        },
        {
          id: "dns",
          workspaceId: "equities",
          protocol: "udp",
          localPort: 8080,
          remotePort: 53,
        },
      ],
    } as const;

    deepStrictEqual(parseCoderProfileConfig(config), config);
    throws(() =>
      parseCoderProfileConfig({
        ...base,
        portForwards: [
          config.portForwards[0],
          { ...config.portForwards[0], id: "duplicate" },
        ],
      }),
    );
    throws(() =>
      parseCoderProfileConfig({
        ...base,
        portForwards: [{ ...config.portForwards[0], workspaceId: "missing" }],
      }),
    );
    throws(() =>
      parseCoderProfileConfig({
        ...base,
        portForwards: [{ ...config.portForwards[0], localPort: 70_000 }],
      }),
    );
  });

  it("drops legacy project roots from workspace connection profiles", () => {
    deepStrictEqual(
      parseCoderProfileConfig({
        version: 1,
        deployments: [
          { id: "goldman-us", name: "Goldman US", url: "https://coder.example.gs.com" },
        ],
        workspaces: [
          {
            id: "equities",
            name: "Equities workspace",
            deploymentId: "goldman-us",
            workspace: "equities-dev",
            workspaceRoot: "/workspace/legacy-project",
          },
        ],
      }),
      {
        version: 1,
        deployments: [
          { id: "goldman-us", name: "Goldman US", url: "https://coder.example.gs.com" },
        ],
        workspaces: [
          {
            id: "equities",
            name: "Equities workspace",
            deploymentId: "goldman-us",
            workspace: "equities-dev",
          },
        ],
      },
    );
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
          },
        ],
      }),
    );
  });

  it("rejects duplicate workspace targets on the same deployment", () => {
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example" }],
        workspaces: [
          {
            id: "one",
            name: "One",
            deploymentId: "goldman",
            workspace: "henry/equities",
          },
          {
            id: "two",
            name: "Two",
            deploymentId: "goldman",
            workspace: "henry/equities",
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

  it("rejects deployment ids that could escape an isolated Coder profile directory", () => {
    throws(() =>
      parseCoderProfileConfig({
        version: 1,
        deployments: [{ id: "../other-profile", name: "Goldman", url: "https://coder.example" }],
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
          },
        ],
      }),
    );
  });
});
