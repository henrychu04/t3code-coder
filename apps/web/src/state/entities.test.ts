import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  initializeActiveEnvironmentId,
  readActiveEnvironmentId,
  resolveThreadDetailRef,
  setActiveEnvironmentId,
} from "./entities";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});

describe("initializeActiveEnvironmentId", () => {
  beforeEach(() => setActiveEnvironmentId(null));
  afterEach(() => setActiveEnvironmentId(null));

  it("initializes an unset active environment", () => {
    const environmentId = EnvironmentId.make("environment-1");

    initializeActiveEnvironmentId(environmentId);

    expect(readActiveEnvironmentId()).toBe(environmentId);
  });

  it("does not replace the active environment", () => {
    const activeEnvironmentId = EnvironmentId.make("environment-1");
    setActiveEnvironmentId(activeEnvironmentId);

    initializeActiveEnvironmentId(EnvironmentId.make("environment-2"));

    expect(readActiveEnvironmentId()).toBe(activeEnvironmentId);
  });
});
