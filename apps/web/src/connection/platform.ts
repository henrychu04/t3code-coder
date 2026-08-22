import {
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
} from "@t3tools/client-runtime/platform";
import {
  Connectivity,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { connectionStorageLayer } from "./storage";

let nextObservedRpcRequestId = 0;

const connectivityLayer = Connectivity.layer({
  status: Effect.succeed("online"),
  changes: Stream.empty,
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.sync(() => {
    const descriptor = readPrimaryEnvironmentDescriptor();
    if (descriptor === null) throw new Error("Coder workspace descriptor is unavailable.");
    const resolved = readPrimaryEnvironmentTarget();
    const registration = new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: resolved.target.httpBaseUrl,
        wsBaseUrl: resolved.target.wsBaseUrl,
      }),
    });
    return PlatformConnectionSource.of({ registrations: Stream.make([registration]) });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) => Effect.sync(() => clearComposerDraftsEnvironment(environmentId)),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        const requestId = `${environmentId}:${++nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
        return Effect.sync(() => acknowledgeRpcRequest(requestId));
      }),
  }),
);

type ConnectionPlatformServices =
  | Layer.Success<typeof connectionStorageLayer>
  | Layer.Success<typeof connectivityLayer>
  | Layer.Success<typeof wakeupsLayer>
  | Layer.Success<typeof platformConnectionSourceLayer>
  | Layer.Success<typeof environmentOwnedDataCleanupLayer>
  | Layer.Success<typeof rpcRequestObserverLayer>;

export const connectionPlatformLayer: Layer.Layer<ConnectionPlatformServices> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
