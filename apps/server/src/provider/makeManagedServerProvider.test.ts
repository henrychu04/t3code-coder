import { it, assert } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
import { ServerSettingsService, layerTest } from "../serverSettings.ts";
const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
it.effect(
  "reschedules health checks on settings changes and keeps explicit refresh available when disabled",
  () =>
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      const settings = yield* ServerSettingsService;
      const changes = yield* PubSub.unbounded<import("@t3tools/contracts").ServerSettings>();
      const provider = yield* makeManagedServerProvider({
        getSettings: Effect.succeed({}),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () => Effect.succeed(snapshot),
        checkProvider: Ref.update(count, (n) => n + 1).pipe(Effect.as(snapshot)),
      }).pipe(
        Effect.provideService(ServerSettingsService, {
          ...settings,
          subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
        }),
      );
      yield* TestClock.adjust("1 second");
      const initial = yield* Ref.get(count);
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Ref.get(count), initial);
      yield* provider.refresh;
      assert.equal(yield* Ref.get(count), initial + 1);
      yield* settings
        .updateSettings({ providerHealthRefreshInterval: Duration.seconds(10) })
        .pipe(Effect.flatMap((value) => PubSub.publish(changes, value)));
      yield* TestClock.adjust("21 seconds");
      const running = yield* Ref.get(count);
      assert.isAbove(running, initial + 1);
      yield* settings
        .updateSettings({ providerHealthRefreshInterval: Duration.zero })
        .pipe(Effect.flatMap((value) => PubSub.publish(changes, value)));
      yield* TestClock.adjust("1 second");
      const stopped = yield* Ref.get(count);
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Ref.get(count), stopped);
    }).pipe(
      Effect.provide(layerTest({ providerHealthRefreshInterval: Duration.zero })),
      Effect.scoped,
    ),
);
