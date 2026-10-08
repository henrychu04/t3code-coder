import { Connection } from "@t3tools/client-runtime/connection";
import { ThreadHistoryController } from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

// Coder: thread and shell snapshots load over helper stdio, so the only loader service is
// history paging. Merge-request diffs use the `pullRequests.diff` RPC.
const snapshotLoaderLayer = ThreadHistoryController.layer;

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer;

const providedClientConnectionLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(Connection.layer),
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedConnectionPlatformLayer)),
);

const connectionLayer = providedClientConnectionLayer;

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
