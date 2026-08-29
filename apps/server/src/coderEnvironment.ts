// @effect-diagnostics globalProcess:off -- The helper runs only inside a Linux Coder workspace.
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../package.json" with { type: "json" };
import * as ServerConfig from "./config.ts";

export class CoderEnvironment extends Context.Service<
  CoderEnvironment,
  { readonly descriptor: ExecutionEnvironmentDescriptor }
>()("t3/coderEnvironment") {}

const platformArch = (): ExecutionEnvironmentDescriptor["platform"]["arch"] => {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  return "other";
};

export const layer = Layer.effect(
  CoderEnvironment,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const existing = yield* fileSystem.readFileString(config.environmentIdPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      ),
    );
    const environmentId = EnvironmentId.make(
      existing.length > 0 ? existing : yield* crypto.randomUUIDv4,
    );
    const configuredLabel = process.env.T3_CODER_WORKSPACE_LABEL?.trim();
    if (existing.length === 0) {
      yield* fileSystem.writeFileString(config.environmentIdPath, `${environmentId}\n`);
    }
    return CoderEnvironment.of({
      descriptor: {
        environmentId,
        label: configuredLabel || path.basename(config.cwd) || "Coder workspace",
        platform: { os: "linux", arch: platformArch() },
        serverVersion: packageJson.version,
        capabilities: {
          repositoryIdentity: true,
          pullRequests: true,
          connectionProbe: true,
          threadSettlement: true,
          threadSnooze: true,
          threadPinning: true,
          threadPinReorder: true,
          threadTitleRegeneration: true,
          threadPullRequestLinking: true,
        },
      },
    });
  }),
);
