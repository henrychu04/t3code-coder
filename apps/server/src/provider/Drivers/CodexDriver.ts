import { CodexSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CoderBackgroundPolicy from "../../coderBackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { makeCodexMcpServerNameResolver } from "../Layers/CodexIntegrationPolicy.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "../Layers/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../Layers/codexLaunchArgs.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { applyBundledModelManifest } from "../ModelManifest.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const DRIVER_KIND = ProviderDriverKind.make("codex");

export type CodexDriverEnv =
  | CoderBackgroundPolicy.CoderBackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { attachmentsDir, cwd } = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const homeLayout = yield* resolveCodexHomeLayout(config);
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const classifyAndStamp = (draft: ServerProviderDraft): ServerProvider =>
        stampIdentity(applyBundledModelManifest(draft, DRIVER_KIND));

      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );

      const effectiveConfig = {
        ...config,
        enabled,
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;
      const resolveMcpServerNames = yield* makeCodexMcpServerNameResolver({
        binaryPath: effectiveConfig.binaryPath || "codex",
        launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
        homePath: effectiveConfig.homePath,
        environment: processEnv,
      });
      const adapter = yield* makeCodexAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        attachmentsDir,
        resolveMcpServerNames,
      });
      const textGeneration = yield* makeCodexTextGeneration(
        effectiveConfig,
        processEnv,
        attachmentsDir,
        resolveMcpServerNames,
      );
      const checkProvider = checkCodexProviderStatus(
        effectiveConfig,
        undefined,
        processEnv,
        cwd,
      ).pipe(
        Effect.map(classifyAndStamp),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshot = yield* makeManagedServerProvider<CodexSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingCodexProvider(settings).pipe(Effect.map(classifyAndStamp)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
