import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { createModelCapabilities } from "@t3tools/shared/model";

import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const capabilities = createModelCapabilities({ optionDescriptors: [] });

const makeProvider = (overrides?: Partial<ServerProvider>): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(CLAUDE_AGENT_DRIVER),
  driver: CLAUDE_AGENT_DRIVER,
  enabled: true,
  installed: true,
  version: "2.1.227",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-24T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const model = (slug: string): ServerProvider["models"][number] => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities,
});

describe("mergeProviderSnapshot", () => {
  it("removes stale models after a successful capability refresh", () => {
    const previous = makeProvider({ models: [model("sonnet"), model("fable-5")] });
    const next = makeProvider({ models: [model("sonnet")] });

    expect(mergeProviderSnapshot(previous, next).models.map(({ slug }) => slug)).toEqual([
      "sonnet",
    ]);
  });

  it("retains known models while a capability refresh is degraded", () => {
    const previous = makeProvider({ models: [model("sonnet")] });
    const next = makeProvider({
      status: "warning",
      auth: { status: "unknown" },
      models: [],
    });

    expect(mergeProviderSnapshot(previous, next).models.map(({ slug }) => slug)).toEqual([
      "sonnet",
    ]);
  });
});
