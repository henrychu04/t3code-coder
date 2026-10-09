import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreparedConnection } from "../connection/model.ts";

// Coder: there is no shell snapshot RPC or environment HTTP listener. Use upstream's full-stream fallback.
export class ShellSnapshotLoader extends Context.Reference<{
  readonly load: (
    prepared: PreparedConnection,
  ) => Effect.Effect<Option.Option<DeferredShellSnapshot>>;
}>("@t3tools/client-runtime/state/shellSnapshotHttp/ShellSnapshotLoader", {
  defaultValue: () => ({ load: () => Effect.succeed(Option.none()) }),
}) {}
