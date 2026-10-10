// Coder: the browser runtime has no primary-environment HTTP client, relay, DPoP, or tracer.
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import { browserCryptoLayer } from "./browserCrypto";

const runtimeLayer = Layer.mergeAll(browserCryptoLayer, Socket.layerWebSocketConstructorGlobal);

export const runtime = ManagedRuntime.make(runtimeLayer);
export const runtimeContextLayer = Layer.effectContext(runtime.contextEffect);
