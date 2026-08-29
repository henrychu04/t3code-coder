// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { expect } from "vite-plus/test";

import {
  CodexIntegrationPolicyError,
  discoverCodexMcpServerNames,
} from "./CodexIntegrationPolicy.ts";

it.layer(NodeServices.layer)("CodexIntegrationPolicy", (it) => {
  it.effect("discovers unique MCP names without retaining transport configuration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-mcp-list-" });
      const binaryPath = path.join(tempDir, "codex");
      const argsPath = path.join(tempDir, "args");
      yield* fileSystem.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$@" > "$T3_FAKE_ARGS_PATH"',
          'printf "%s" "$T3_FAKE_MCP_LIST"',
          "",
        ].join("\n"),
      );
      yield* fileSystem.chmod(binaryPath, 0o755);

      const names = yield* discoverCodexMcpServerNames({
        binaryPath,
        launchArgs: "--strict-config --enable apps --listen off",
        cwd: tempDir,
        environment: {
          ...process.env,
          T3_FAKE_ARGS_PATH: argsPath,
          T3_FAKE_MCP_LIST: JSON.stringify([
            { name: "workspace-tools", transport: { env: { SECRET: "do-not-retain" } } },
            { name: "plugin.tools", enabled: true },
            { name: "workspace-tools", enabled: false },
          ]),
        },
      });

      expect(names).toEqual(["workspace-tools", "plugin.tools"]);
      expect((yield* fileSystem.readFileString(argsPath)).split("\n")).toEqual([
        "--enable",
        "apps",
        "--config",
        "features.apps=false",
        "mcp",
        "list",
        "--json",
        "",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed when MCP discovery does not return valid JSON", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-mcp-bad-" });
      const binaryPath = path.join(tempDir, "codex");
      yield* fileSystem.writeFileString(binaryPath, "#!/bin/sh\nprintf 'not-json'\n");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const result = yield* discoverCodexMcpServerNames({
        binaryPath,
        cwd: tempDir,
        environment: process.env,
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(CodexIntegrationPolicyError);
        expect(result.failure.message).not.toContain("not-json");
      }
    }).pipe(Effect.scoped),
  );
});
