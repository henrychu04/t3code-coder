import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const query = vi.hoisted(() => vi.fn());
vi.mock("../Drivers/ClaudeCli.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../Drivers/ClaudeCli.ts")>()),
  query,
}));

import { probeClaudeCapabilities } from "./ClaudeProvider.ts";

it.layer(NodeServices.layer)("Claude optional probe deadlines", (it) => {
  it.effect("does not discard slow successful initialization while optional usage is pending", () =>
    Effect.gen(function* () {
      const initialized = yield* Deferred.make<void>();
      const usageStarted = yield* Deferred.make<void>();
      let finishInit!: (value: unknown) => void;
      let finishUsage!: (value: unknown) => void;
      let aborted = false;
      const getUsage = vi.fn(() => {
        Deferred.doneUnsafe(usageStarted, Effect.void);
        return new Promise((resolve) => {
          finishUsage = resolve;
        });
      });
      query.mockImplementation(({ options }) => {
        options.abortController.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          initializationResult: () => {
            Deferred.doneUnsafe(initialized, Effect.void);
            return new Promise((resolve) => {
              finishInit = resolve;
            });
          },
          getSettings: async () => ({}),
          getUsage,
        };
      });
      const fiber = yield* probeClaudeCapabilities(Schema.decodeSync(ClaudeSettings)({})).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(initialized);
      yield* TestClock.adjust("24 seconds");
      finishInit({ account: { tokenSource: "oauth" }, commands: [], models: [] });
      yield* Deferred.await(usageStarted);
      assert.deepEqual(getUsage.mock.calls[0], [5_000]);
      yield* TestClock.adjust("2 seconds");
      assert.equal(aborted, false);
      finishUsage({ rate_limits_available: false });
      const result = yield* Fiber.join(fiber);
      assert.equal(result?.tokenSource, "oauth");
      assert.equal(aborted, true);
    }).pipe(Effect.scoped),
  );
});
