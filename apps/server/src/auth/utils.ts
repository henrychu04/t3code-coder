// Coder: only upstream's encoding helpers that signed asset URLs use; sessions, cookies, and client
// metadata belong to upstream's HTTP auth, which is not carried.
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

export function base64UrlEncode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? Base64Url.encode(new TextEncoder().encode(input))
    : Base64Url.encode(input);
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Base64Url.decodeString(input));
}
