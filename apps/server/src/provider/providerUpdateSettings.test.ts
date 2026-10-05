import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerSettingsService, layerTest } from "../serverSettings.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "./providerUpdateSettings.ts";

it("defaults provider update checks to enabled and accepts disabling patches", () => {
  assert.equal(DEFAULT_SERVER_SETTINGS.enableProviderUpdateChecks, true);
  assert.deepEqual(Schema.decodeSync(ServerSettingsPatch)({ enableProviderUpdateChecks: false }), {
    enableProviderUpdateChecks: false,
  });
});

it.effect("reads changed update settings and streams only relevant snapshot settings", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const provider = { binaryPath: "workspace-provider" };
    const current = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
    const source = makeProviderSnapshotSettingsSource(provider, {
      ...settings,
      getSettings: Ref.get(current),
      streamChanges: Stream.make(
        DEFAULT_SERVER_SETTINGS,
        { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
        {
          ...DEFAULT_SERVER_SETTINGS,
          enableProviderUpdateChecks: false,
          addProjectBaseDirectory: "/project",
        },
      ),
    });
    const initial = yield* source.getSettings;
    assert.equal(initial.enableProviderUpdateChecks, true);
    yield* Ref.set(current, { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false });
    const disabled = yield* source.getSettings;
    assert.equal(disabled.enableProviderUpdateChecks, false);
    assert.strictEqual(disabled.provider, provider);
    assert.equal(haveProviderSnapshotSettingsChanged(initial, disabled), true);
    const changes = yield* Stream.runCollect(source.streamSettings);
    assert.equal(haveProviderSnapshotSettingsChanged(changes[0]!, changes[1]!), true);
    assert.equal(haveProviderSnapshotSettingsChanged(changes[1]!, changes[2]!), false);
  }).pipe(Effect.provide(layerTest())),
);
