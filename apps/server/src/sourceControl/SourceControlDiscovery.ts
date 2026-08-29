import type { SourceControlDiscoveryResult, VcsDiscoveryItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { detailFromCause, firstNonEmptyLine } from "./SourceControlProviderDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as GitLabCli from "./GitLabCli.ts";

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  { readonly discover: Effect.Effect<SourceControlDiscoveryResult> }
>()("t3/sourceControl/SourceControlDiscovery") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const process = yield* VcsProcess.VcsProcess;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const gitLab = yield* GitLabCli.GitLabCli;

  const discoverGit: Effect.Effect<VcsDiscoveryItem> = process
    .run({
      operation: "source-control.discovery.probe",
      command: "git",
      args: ["--version"],
      cwd: config.cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 8_000,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map((result) => ({
        kind: "git" as const,
        label: "Git",
        executable: "git",
        implemented: true,
        status: "available" as const,
        version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
          firstNonEmptyLine(result.stderr),
        ),
        installHint: "Git is required in the Coder workspace.",
        detail: Option.none<string>(),
      })),
      Effect.catch((cause) =>
        Effect.succeed({
          kind: "git" as const,
          label: "Git",
          executable: "git",
          implemented: true,
          status: "missing" as const,
          version: Option.none<string>(),
          installHint: "Install Git in the Coder workspace.",
          detail: detailFromCause(cause),
        }),
      ),
    );

  return SourceControlDiscovery.of({
    discover: Effect.all([
      discoverGit,
      providers.discover,
      gitLab.probeWriteAccess({ cwd: config.cwd }),
    ]).pipe(
      Effect.map(([git, sourceControlProviders, writeAccess]) => ({
        versionControlSystems: [git],
        sourceControlProviders: sourceControlProviders.map((provider) =>
          provider.kind === "gitlab" ? { ...provider, writeAccess } : provider,
        ),
      })),
    ),
  });
});

export const layer = Layer.effect(SourceControlDiscovery, make);
