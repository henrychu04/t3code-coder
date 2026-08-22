import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { type ConnectionAttemptError, type PreparedConnection } from "./model.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

function primarySocketUrl(wsBaseUrl: string): string {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  return url.toString();
}

export const make = Effect.succeed(
  ConnectionResolver.of({
    prepare: Effect.fn("clientRuntime.connection.resolver.prepare")(function* (entry) {
      const target = entry.target;
      return {
        environmentId: target.environmentId,
        label: target.label,
        socketUrl: primarySocketUrl(target.wsBaseUrl),
        target,
      } satisfies PreparedConnection;
    }),
  }),
);

export const layer = Layer.effect(ConnectionResolver, make);
