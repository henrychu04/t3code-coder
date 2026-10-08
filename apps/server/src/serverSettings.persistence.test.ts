import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL, ProjectId } from "@t3tools/contracts";
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
  it.effect("persists merge preferences and clears only the selected project's override", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.start;
      const projectA = ProjectId.make("project-a");
      const projectB = ProjectId.make("project-b");
      yield* settings.updateSettings({
        pullRequestMergeMethod: "squash",
        projectSettingsOverrides: {
          [projectA]: { pullRequestMergeMethod: "rebase" },
          [projectB]: { pullRequestMergeMethod: "merge" },
        },
      });
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(config.settingsPath)), {
        pullRequestMergeMethod: "squash",
        projectSettingsOverrides: {
          [projectA]: { pullRequestMergeMethod: "rebase" },
          [projectB]: { pullRequestMergeMethod: "merge" },
        },
      });
      yield* settings.updateSettings({ projectSettingsOverrides: { [projectA]: null } });
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(config.settingsPath)), {
        pullRequestMergeMethod: "squash",
        projectSettingsOverrides: { [projectB]: { pullRequestMergeMethod: "merge" } },
      });
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("writes and clears a non-default automatic Git fetch interval", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.start;

      const updated = yield* settings.updateSettings({
        automaticGitFetchInterval: Duration.seconds(45),
      });

      assert.strictEqual(Duration.toMillis(updated.automaticGitFetchInterval), 45_000);
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(config.settingsPath)), {
        automaticGitFetchInterval: 45_000,
        backgroundActivity: {
          baseProfile: "balanced",
          overrides: { automaticGitFetchInterval: 45_000 },
          profile: "custom",
        },
      });

      const reset = yield* settings.updateSettings({
        automaticGitFetchInterval: DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
      });

      assert.strictEqual(
        Duration.toMillis(reset.automaticGitFetchInterval),
        Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
      );
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(config.settingsPath)), {});
    }).pipe(Effect.provide(settingsLayer)),
  );
});
