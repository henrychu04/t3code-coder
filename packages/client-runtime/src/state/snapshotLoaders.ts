import type {
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";

export interface ThreadSnapshotWindow {
  readonly turnLimit: number;
  readonly beforeCursor?: string;
}

export class ShellSnapshotLoader extends Context.Service<
  ShellSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<OrchestrationShellSnapshot>>;
  }
>()("@t3tools/client-runtime/state/snapshotLoaders/ShellSnapshotLoader") {}

export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      window?: ThreadSnapshotWindow,
    ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  }
>()("@t3tools/client-runtime/state/snapshotLoaders/ThreadSnapshotLoader") {}

// Coder-only clients receive authoritative snapshots through the RPC socket.
// Returning none selects that built-in socket path without creating HTTP clients.
export const shellSnapshotLoaderLayer = Layer.succeed(
  ShellSnapshotLoader,
  ShellSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
);

export const threadSnapshotLoaderLayer = Layer.succeed(
  ThreadSnapshotLoader,
  ThreadSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
);
