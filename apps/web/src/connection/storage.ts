import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const noValue = Effect.succeed(Option.none());

// The browser is a stateless view of the selected Coder workspace. Durable
// projects, threads, messages, credentials, and caches stay in that workspace.
export const connectionStorageLayer = Layer.succeedContext(
  Context.make(
    EnvironmentCacheStore,
    EnvironmentCacheStore.of({
      loadShell: () => noValue,
      saveShell: () => Effect.void,
      loadThread: () => noValue,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => noValue,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => noValue,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    }),
  ),
);
