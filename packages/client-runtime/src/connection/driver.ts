// Coder: each environment has one route, the loopback gateway's WebSocket for a Coder workspace,
// so upstream's multi-route checks, preflight, and descriptor fetches are absent, and
// `checkHost` never answers (see below).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as RpcSession from "../rpc/session.ts";

export type RouteCheck = "answered" | "silent" | "unchecked";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    /** Asks the host behind a live session to answer a fresh request on the session's own origin. */
    readonly checkHost: (prepared: PreparedConnection) => Effect.Effect<RouteCheck>;
  }
>()("@t3tools/client-runtime/connection/driver/ConnectionDriver") {}

/** @public */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;

  // Coder: the session's origin is the loopback gateway, which answers whether or not the
  // workspace behind `coder ssh` does, so no fresh request shows a silent socket is dead. The
  // supervisor's silent socket check then ends only on a frame, and the probe timeout decides.
  const checkHost = (_prepared: PreparedConnection) => Effect.succeed<RouteCheck>("unchecked");

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* resolver.prepare(entry);
    yield* reportProgress({ stage: "opening", prepared });
    const session = yield* sessions.connect(prepared);
    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies EnvironmentConnectionLease;
  });

  return ConnectionDriver.of({ connect, checkHost });
});

export const layer = Layer.effect(ConnectionDriver, make);
