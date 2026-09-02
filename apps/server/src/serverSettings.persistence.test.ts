import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";

const settingsLayer = ServerSettings.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-server-settings-test-",
    }),
  ),
);

it.layer(NodeServices.layer)("server settings persistence", (it) => {
  it.effect("writes and clears a non-default automatic Git fetch interval", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.start;

      const updated = yield* settings.updateSettings({
        automaticGitFetchInterval: Duration.seconds(30),
      });

      assert.strictEqual(Duration.toMillis(updated.automaticGitFetchInterval), 30_000);
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(config.settingsPath)), {
        automaticGitFetchInterval: 30_000,
      });

      const reset = yield* settings.updateSettings({
        automaticGitFetchInterval: DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
      });

      assert.strictEqual(
        Duration.toMillis(reset.automaticGitFetchInterval),
        Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
      );
      assert.deepStrictEqual(
        JSON.parse(yield* fileSystem.readFileString(config.settingsPath)),
        {},
      );
    }).pipe(Effect.provide(settingsLayer)),
  );
});
