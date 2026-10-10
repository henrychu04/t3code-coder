// Coder: the helper's capability set must account for every upstream capability.
import { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CODER_ENVIRONMENT_CAPABILITIES, CODER_OMITTED_CAPABILITIES } from "./coderEnvironment.ts";

describe("CoderEnvironment capabilities", () => {
  it("advertises or explicitly omits every capability key", () => {
    const capabilityKeys = Object.keys(ExecutionEnvironmentCapabilities.fields).toSorted();
    const advertised = Object.keys(CODER_ENVIRONMENT_CAPABILITIES);
    const omitted = Object.keys(CODER_OMITTED_CAPABILITIES);

    expect(advertised.filter((key) => omitted.includes(key))).toEqual([]);
    expect([...advertised, ...omitted].toSorted()).toEqual(capabilityKeys);
    for (const reason of Object.values(CODER_OMITTED_CAPABILITIES)) {
      expect(reason.trim()).not.toBe("");
    }
  });
});
