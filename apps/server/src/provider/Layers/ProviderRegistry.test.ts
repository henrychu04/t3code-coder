import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { listProviderWorkspaceSlashCommands } from "../../coderWs.ts";

import {
  mergeProviderSnapshot,
  upsertProviderWorkspaceSnapshot,
  ProviderRegistryLive,
} from "./ProviderRegistry.ts";

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

describe("project catalogs", () => {
  it.effect("returns the requested project commands, including an empty catalog", () =>
    Effect.gen(function* () {
      const provider = makeProvider({
        slashCommands: [{ name: "default", description: "Default" }],
      });
      const scoped = upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        makeProvider({ slashCommands: [{ name: "project", description: "Project" }] }),
      );
      for (const commands of [scoped.workspaceSnapshots![0]!.slashCommands, []]) {
        const snapshot = {
          ...scoped,
          workspaceSnapshots: [{ ...scoped.workspaceSnapshots![0]!, slashCommands: commands }],
        };
        const result = yield* listProviderWorkspaceSlashCommands(
          { instanceId: provider.instanceId, cwd: "/project" },
          { refreshWorkspaceSnapshot: () => Effect.succeed([snapshot]) },
          { getInstance: () => Effect.die("must not fall back to default commands") },
        );
        expect(result).toEqual(commands);
      }
    }),
  );

  it.effect("publishes catalog removal when an otherwise identical provider is rebuilt", () =>
    Effect.gen(function* () {
      const provider = makeProvider();
      const instance = {
        instanceId: provider.instanceId,
        driverKind: provider.driver,
        snapshot: {
          getSnapshot: Effect.succeed(provider),
          refresh: Effect.succeed(provider),
          streamChanges: Stream.never,
        },
        snapshotForCwd: () =>
          Effect.succeed(
            makeProvider({
              skills: [{ name: "project", path: "/project/SKILL.md", enabled: true }],
            }),
          ),
      } as unknown as ProviderInstance;
      const current = yield* Ref.make(instance);
      const changes = yield* PubSub.unbounded<void>();
      const registryLayer = ProviderRegistryLive.pipe(
        Layer.provide(
          Layer.succeed(ProviderInstanceRegistry, {
            getInstance: () => Ref.get(current),
            listInstances: Ref.get(current).pipe(Effect.map((value) => [value])),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes),
          }),
        ),
        Layer.provide(ServerConfig.layerTest("/project", { prefix: "t3-provider-review-" })),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        yield* registry.refreshWorkspaceSnapshot({
          instanceId: provider.instanceId,
          cwd: "/project",
        });
        const update = yield* registry.streamChanges.pipe(Stream.runHead, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Ref.set(current, { ...instance });
        yield* PubSub.publish(changes, undefined);
        const received = yield* Fiber.join(update);
        expect(received._tag).toBe("Some");
        if (received._tag === "Some") expect(received.value[0]?.workspaceSnapshots).toBeUndefined();
        const snapshots = yield* registry.getProviders;
        expect(snapshots[0]?.workspaceSnapshots).toBeUndefined();
      }).pipe(Effect.provide(registryLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("keeps project skills separate and bounds the number of cached projects", () => {
    let provider = makeProvider();
    for (let i = 0; i < 18; i++) {
      provider = upsertProviderWorkspaceSnapshot(
        provider,
        `/project-${i}`,
        makeProvider({
          skills: [{ name: `skill-${i}`, path: `/project-${i}/SKILL.md`, enabled: true }],
        }),
      );
    }
    expect(provider.skills).toEqual([]);
    expect(provider.workspaceSnapshots).toHaveLength(16);
    expect(provider.workspaceSnapshots?.[0]?.cwd).toBe("/project-2");
    const updated = upsertProviderWorkspaceSnapshot(provider, "/project-2", makeProvider());
    expect(updated.workspaceSnapshots?.at(-1)?.skills).toEqual([]);
    expect(updated.workspaceSnapshots).toHaveLength(16);
  });
});
