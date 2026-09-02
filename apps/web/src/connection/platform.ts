import {
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionRegistration,
  ConnectionTarget,
  Connectivity,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import {
  readCoderWorkspaceEnvironments,
  subscribeCoderWorkspaceEnvironments,
} from "../coder/environmentStore";
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
    const registrations = () =>
      readCoderWorkspaceEnvironments().map(({ workspaceId, descriptor }) => {
        const socketUrl = new URL(window.location.origin);
        socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
        socketUrl.pathname = `/api/workspaces/${encodeURIComponent(workspaceId)}/rpc`;
        return new ConnectionRegistration({
          target: new ConnectionTarget({
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            httpBaseUrl: window.location.origin,
            wsBaseUrl: socketUrl.toString(),
          }),
        });
      });
    return PlatformConnectionSource.of({
      registrations: Stream.callback<ReadonlyArray<ConnectionRegistration>>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            Queue.offerUnsafe(queue, registrations());
            return subscribeCoderWorkspaceEnvironments(() => {
              Queue.offerUnsafe(queue, registrations());
            });
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ).pipe(Effect.asVoid),
      ),
    });
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
