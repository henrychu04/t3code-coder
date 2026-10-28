/**
 * Coder: upstream's PeerMcpClient calls a linked environment's `/mcp` over HTTP with an OAuth
 * session. Here the call goes through the gateway hub instead (`coderHub.ts`): the laptop
 * gateway runs it on the other workspace's helper as that link's caller, which applies the
 * same access and fence. The service tag and `call` are upstream's, so `PeerForwarding` and
 * `RemoteDelegation` stay upstream's.
 *
 * @module peer/PeerMcpClient
 */
import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CoderHub from "../coderHub.ts";

/** The limits a call carries to the peer: the calling agent's modes here. */
export interface PeerCallLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Calls a linked workspace's T3 tools for an agent here. Each call carries the calling
 * agent's limits, so the other workspace enforces the narrower of those and the link's access.
 */
export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    /** Calls `tool` on the peer and decodes its result with `success`. */
    readonly call: <S extends Schema.Decoder<unknown>>(input: {
      readonly environmentId: EnvironmentId;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: PeerCallLimits;
      readonly success: S;
    }) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

const make = Effect.gen(function* () {
  const hub = yield* CoderHub.CoderHub;

  const call: PeerMcpClient["Service"]["call"] = (input) =>
    hub
      .call({
        environmentId: input.environmentId,
        tool: input.tool,
        arguments: input.arguments,
        limits: input.limits,
      })
      .pipe(
        Effect.flatMap((outcome) =>
          outcome._tag === "Failure"
            ? Effect.fail(outcome.failure)
            : Schema.decodeUnknownEffect(input.success)(outcome.value).pipe(
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message:
                        "The linked workspace's answer did not match this version. Reconnect both workspaces so they run the same helper.",
                    }),
                ),
              ),
        ),
        Effect.withSpan("PeerMcpClient.call"),
      );

  return PeerMcpClient.of({ call });
});

export const layer = Layer.effect(PeerMcpClient, make);
