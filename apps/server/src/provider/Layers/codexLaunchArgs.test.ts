import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexMcpListArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("disables apps for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), [
      "app-server",
      "--config",
      "features.apps=false",
    ]);
  });

  it("appends per-server integration overrides after parsed launch args", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(
        '--strict-config --enable foo --config mcp_servers.bad.command="danger" --enable apps',
        ["bad", "plugin.server", 'quoted"name'],
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "--config",
        "mcp_servers.bad.command=danger",
        "--enable",
        "apps",
        "--config",
        'mcp_servers={"bad"={enabled=false},"plugin.server"={enabled=false},"quoted\\\"name"={enabled=false}}',
        "--config",
        "features.apps=false",
      ],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      [
        "--strict-config",
        "--enable",
        "foo",
        "--config",
        "model=gpt 5",
        "--config",
        "features.apps=false",
      ],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
      "--config",
      "features.apps=false",
    ]);
  });
});

describe("codexMcpListArgs", () => {
  it("keeps root config overrides, removes app-server flags, and disables apps", () => {
    NodeAssert.deepStrictEqual(
      codexMcpListArgs('--strict-config --listen off --config model="gpt 5" --enable apps'),
      [
        "--config",
        "model=gpt 5",
        "--enable",
        "apps",
        "--config",
        "features.apps=false",
        "mcp",
        "list",
        "--json",
      ],
    );
  });
});
