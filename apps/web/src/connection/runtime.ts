import { Connection } from "@t3tools/client-runtime/connection";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer;

const providedClientConnectionLayer = Connection.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedConnectionPlatformLayer)),
);

const connectionLayer = providedClientConnectionLayer;

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
