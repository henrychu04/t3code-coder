import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";

import { browserCryptoLayer } from "./browserCrypto";

const runtimeLayer = Layer.mergeAll(browserCryptoLayer, Socket.layerWebSocketConstructorGlobal);

export const runtime = ManagedRuntime.make(runtimeLayer);
export const runtimeContextLayer = Layer.effectContext(runtime.contextEffect);
