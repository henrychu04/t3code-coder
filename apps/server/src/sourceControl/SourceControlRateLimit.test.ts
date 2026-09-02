import { assert, it } from "@effect/vitest";

import { retryAtFromHeader } from "./SourceControlRateLimit.ts";

it("caps provider Retry-After values at the maximum fallback cooldown", () => {
  const now = 1_000;
  const maximum = now + 15 * 60 * 1_000;

  assert.equal(retryAtFromHeader("86400", now), maximum);
  assert.equal(retryAtFromHeader("Thu, 01 Jan 2099 00:00:00 GMT", now), maximum);
});
