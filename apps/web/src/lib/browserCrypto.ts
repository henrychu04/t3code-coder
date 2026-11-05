import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Layer from "effect/Layer";

// Coder: upstream's browser runtime takes these from `cloud/dpop.ts`'s layer, which is not carried.
export const browserCryptoLayer = Layer.mergeAll(
  SecureRandom.layerWebCrypto,
  Digest.layerWebCrypto,
);
