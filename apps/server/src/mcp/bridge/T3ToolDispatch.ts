/**
 * Coder: the late-bound entry point between T3 tool credentials and upstream's toolkits.
 *
 * The session registry hands out bridges for provider sessions, while the toolkits need the
 * orchestrator that owns those sessions. This module imports neither side, so the registry can
 * depend on it without an import cycle; workspace startup binds the toolkits once the
 * orchestrator exists.
 *
 * @module mcp/bridge/T3ToolDispatch
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as McpInvocationContext from "../McpInvocationContext.ts";
import {
  type FileBridgeCatalogEntry,
  type FileBridgeRequest,
  FileBridgeToolFailure,
} from "./FileBridge.ts";

export const t3ToolFailure = (error: string, message: string) =>
  new FileBridgeToolFailure({ value: { error, message } });

export interface T3ToolBinding {
  /** What `--list` and `--schema` show. */
  readonly catalog: ReadonlyArray<FileBridgeCatalogEntry>;
  readonly dispatch: (
    scope: McpInvocationContext.McpThreadInvocationScope,
    request: FileBridgeRequest,
  ) => Effect.Effect<unknown, FileBridgeToolFailure>;
}

export class T3ToolDispatch extends Context.Service<
  T3ToolDispatch,
  {
    readonly bind: (binding: T3ToolBinding) => Effect.Effect<void>;
    /** The bound toolkits, or nothing while the helper is still starting. */
    readonly binding: Effect.Effect<T3ToolBinding | undefined>;
    readonly dispatch: T3ToolBinding["dispatch"];
  }
>()("t3/mcp/bridge/T3ToolDispatch") {}

export const layer = Layer.effect(
  T3ToolDispatch,
  Effect.gen(function* () {
    const bound = yield* Ref.make<T3ToolBinding | undefined>(undefined);
    return T3ToolDispatch.of({
      bind: (binding) => Ref.set(bound, binding),
      binding: Ref.get(bound),
      dispatch: (scope, request) =>
        Ref.get(bound).pipe(
          Effect.flatMap((binding) =>
            binding === undefined
              ? Effect.fail(
                  t3ToolFailure("T3ToolsNotReady", "T3 tools are starting. Retry shortly."),
                )
              : binding.dispatch(scope, request),
          ),
        ),
    });
  }),
);
