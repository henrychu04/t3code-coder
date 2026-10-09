import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { EnvironmentCacheStore, EnvironmentOwnedDataCleanup } from "../platform/persistence.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const noValue = Effect.succeed(Option.none());

function makeRegistryLayer(cleared: { cache: EnvironmentId[]; owned: EnvironmentId[] }) {
  return EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          EnvironmentCacheStore,
          EnvironmentCacheStore.of({
            loadShell: () => noValue,
            saveShell: () => Effect.void,
            loadThread: () => noValue,
            saveThread: () => Effect.void,
            removeThread: () => Effect.void,
            loadServerConfig: () => noValue,
            saveServerConfig: () => Effect.void,
            loadVcsRefs: () => noValue,
            saveVcsRefs: () => Effect.void,
            removeVcsRefs: () => Effect.void,
            clearVcsRefs: () => Effect.void,
            clear: (environmentId) => Effect.sync(() => void cleared.cache.push(environmentId)),
          }),
        ),
        Layer.succeed(EnvironmentOwnedDataCleanup, {
          clear: (environmentId) => Effect.sync(() => void cleared.owned.push(environmentId)),
        }),
        Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.empty }),
        ConnectionWakeups.layer({ changes: Stream.empty }),
        Layer.succeed(
          ConnectionDriver.ConnectionDriver,
          {} as unknown as ConnectionDriver.ConnectionDriver["Service"],
        ),
      ),
    ),
  );
}

describe("EnvironmentRegistry.remove", () => {
  it.effect("clears browser data only for an explicit removal", () => {
    const cleared = { cache: [] as EnvironmentId[], owned: [] as EnvironmentId[] };
    const environmentId = EnvironmentId.make("registry-removed");
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      // A stopped or disconnected workspace leaves the platform registrations.
      yield* registry.reconcilePlatform([]);
      expect(cleared).toEqual({ cache: [], owned: [] });

      yield* registry.remove(environmentId);
      expect(cleared).toEqual({ cache: [environmentId], owned: [environmentId] });
    }).pipe(Effect.provide(makeRegistryLayer(cleared)));
  });
});
