/**
 * The server's implementation of `ProviderHost.ProviderHost`, the only server surface
 * provider drivers and adapters may use.
 *
 * @module provider/ProviderHostLive
 */
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    return ProviderHost.ProviderHost.of({
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      // Coder: providers authenticate through the workspace's own configuration, and T3 Coder
      // never stores provider credentials: nothing is stored and writes fail.
      credentials: (namespace, bindingId) =>
        Effect.succeed({
          binding: { owner: "t3" as const, key: `${namespace}:${bindingId}` },
          get: Effect.succeed(Option.none<Uint8Array>()),
          set: (_credentials: Uint8Array) =>
            Effect.fail(
              new ProviderCredentialError({
                operation: "set",
                cause: "T3 Coder does not store provider credentials.",
              }),
            ),
          remove: Effect.fail(
            new ProviderCredentialError({
              operation: "remove",
              cause: "T3 Coder does not store provider credentials.",
            }),
          ),
        }),
    });
  }),
);
