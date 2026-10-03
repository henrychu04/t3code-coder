import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as ModelManifest from "./ModelManifest.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  applyProviderCompatibility,
  ProviderCompatibilityPolicy,
  resolveProviderCompatibility,
} from "./providerCompatibility.ts";

const driver = ProviderDriverKind.make("codex");
const policy: ProviderCompatibilityPolicy = {
  driver,
  t3CodeRange: ">=0.0.42 <0.1.0",
  recommendedVersion: "2.0.0",
  recommendedRange: ">=2.0.0 <3.0.0",
  ranges: [
    { range: "<1.0.0", status: "broken" },
    { range: ">=1.0.0 <1.5.0", status: "unsupported" },
    { range: ">=1.5.0 <2.0.0", status: "graceful" },
    { range: ">=2.0.0 <3.0.0", status: "supported" },
  ],
};
const provider: ServerProvider = {
  driver,
  instanceId: ProviderInstanceId.make("codex-work"),
  enabled: true,
  installed: true,
  version: "0.9.0",
  status: "error",
  message: "Authentication failed",
  checkedAt: "2026-09-22T00:00:00Z",
  auth: { status: "unauthenticated" },
  models: [],
  skills: [],
  slashCommands: [],
};

describe("provider compatibility", () => {
  it("bundles a compatibility policy for every built-in harness", () => {
    for (const builtIn of BUILT_IN_DRIVERS) {
      assert.isDefined(
        resolveProviderCompatibility(
          ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
          builtIn.driverKind,
          null,
        ),
        `Missing bundled compatibility policy for ${builtIn.driverKind}`,
      );
    }
  });

  it("classifies boundaries and treats unlisted versions and release tags as unknown", () => {
    for (const [version, expected] of [
      ["0.9.9", "broken"],
      ["1.0.0", "unsupported"],
      ["1.5.0", "graceful"],
      ["2.0.0", "supported"],
      ["v2.0.0", "supported"],
      ["3.0.0", "unknown"],
      ["2.0.0-beta.1", "unknown"],
      [null, "unknown"],
    ] as const) {
      assert.strictEqual(resolveProviderCompatibility([policy], driver, version)?.status, expected);
    }
    assert.isUndefined(resolveProviderCompatibility([policy], driver, "0.9.0", "0.1.0"));
  });

  it("supports Codex 0.156 and marks Codex without Thread.projectId broken", () => {
    const bundled = ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility;
    for (const [codexVersion, expected] of [
      ["0.148.0", "broken"],
      ["0.149.0", "unsupported"],
      ["0.155.0", "unsupported"],
      ["0.156.0", "supported"],
      ["0.159.0", "supported"],
    ] as const) {
      assert.strictEqual(
        resolveProviderCompatibility(bundled, driver, codexVersion, "0.0.45")?.status,
        expected,
        `Codex ${codexVersion}`,
      );
    }
  });

  it("attaches advisories without replacing probe results", () => {
    const broken = applyProviderCompatibility(provider, [policy]);
    assert.strictEqual(broken.compatibilityAdvisory?.status, "broken");
    assert.strictEqual(broken.status, "error");
    assert.strictEqual(broken.message, "Authentication failed");
    const removed = applyProviderCompatibility(broken, []);
    assert.isUndefined(removed.compatibilityAdvisory);
    assert.strictEqual(removed.message, "Authentication failed");
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, enabled: false }, [policy]).compatibilityAdvisory,
    );
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, installed: false }, [policy]).compatibilityAdvisory,
    );
  });

  it("rejects invalid ranges and recommendations outside the first supported match", () => {
    const decode = Schema.decodeUnknownSync(ProviderCompatibilityPolicy);
    assert.doesNotThrow(() => decode(policy));
    const prefixed = decode({
      ...policy,
      t3CodeRange: ">=v0.0.42 <v0.1",
      recommendedRange: "^v2",
      ranges: [{ range: ">=v2.0 <v3", status: "supported" }],
    });
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "2.0.0")?.status,
      "supported",
    );
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "3.0.0")?.status,
      "unknown",
    );
    for (const invalid of [
      { ...policy, t3CodeRange: "*" },
      { ...policy, recommendedVersion: "3.0.0" },
      { ...policy, ranges: [{ range: ">=2.0.0 garbage", status: "supported" }] },
      { ...policy, recommendedVersion: "2.0.0; echo unsafe" },
      { ...policy, ranges: [{ range: ">=0.0.0", status: "broken" }, ...policy.ranges] },
    ])
      assert.throws(() => decode(invalid));
  });
});
