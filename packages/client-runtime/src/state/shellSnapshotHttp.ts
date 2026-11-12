import type { OrchestrationV2ShellResumable } from "@t3tools/contracts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreparedConnection } from "../connection/model.ts";

export interface ShellSnapshotOptions {
  readonly omitIdleSubagents?: boolean;
  readonly omitOlderSettled?: boolean;
  /** The cursor of held rows loaded with these omissions; the server may answer `resumable`. */
  readonly resumeFrom?: number;
}

/** `projectIdentities` names the repository identities the snapshot carried. */
export interface ShellHttpSnapshot extends DeferredShellSnapshot {
  readonly projectIdentities?: string;
}

export type ShellHttpAnswer = ShellHttpSnapshot | OrchestrationV2ShellResumable;

// Coder: there is no shell snapshot RPC or environment HTTP listener. Use upstream's full-stream fallback.
export class ShellSnapshotLoader extends Context.Reference<{
  readonly load: (
    prepared: PreparedConnection,
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<Option.Option<ShellHttpAnswer>>;
}>("@t3tools/client-runtime/state/shellSnapshotHttp/ShellSnapshotLoader", {
  defaultValue: () => ({ load: () => Effect.succeedNone }),
}) {}
