/**
 * Coder: Codex, Claude Code, and Pi authenticate inside the Linux workspace through the provider's
 * own configuration. T3 Coder has no provider sign-in, logout, or credential-transfer flows, so
 * every auth operation is unavailable and prompts are never intercepted as auth commands.
 *
 * @module provider/ProviderAuthService
 */
import {
  ProviderSetupError,
  type ChatGptReconnectProfile,
  type ChatGptTransferredProfile,
  type ProviderAuthRespondInput,
  type ProviderAuthStartInput,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export type { ProviderAuthController } from "@t3tools/provider-core/server/auth";

interface ProviderAuthTarget {
  readonly instanceId: ProviderInstanceId;
}

export class ProviderAuthService extends Context.Service<
  ProviderAuthService,
  {
    readonly reconnectProfile: (
      input: ProviderAuthTarget & { methodId: string },
    ) => Effect.Effect<ChatGptReconnectProfile | null, ProviderSetupError>;
    readonly importProfile: (
      input: ProviderAuthTarget & { profile: ChatGptTransferredProfile },
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly start: (
      input: ProviderAuthStartInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly complete: (
      input: ProviderAuthTarget & { readonly flowId: string; readonly callbackUrl: string },
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly respond: (
      input: ProviderAuthRespondInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly cancel: (
      input: ProviderAuthTarget & { readonly flowId: string },
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly logout: (
      input: ProviderAuthTarget,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly subscribe: (
      input: ProviderAuthTarget,
      ownerSessionId: string,
    ) => Stream.Stream<ProviderAuthState, ProviderSetupError>;
    readonly tryHandlePromptCommand: (
      input: ProviderAuthTarget & { readonly text: string; readonly hasAttachments: boolean },
    ) => Effect.Effect<boolean, ProviderSetupError>;
  }
>()("t3/provider/ProviderAuthService") {}

const unavailable = (instanceId: ProviderInstanceId, operation: string) =>
  new ProviderSetupError({
    instanceId,
    operation,
    detail: "Provider sign-in is managed in the Coder workspace, not by T3 Coder.",
  });

export const layer = Layer.succeed(
  ProviderAuthService,
  ProviderAuthService.of({
    reconnectProfile: Effect.fn("ProviderAuthService.reconnectProfile")(function* (input) {
      return yield* unavailable(input.instanceId, "reconnectProfile");
    }),
    importProfile: Effect.fn("ProviderAuthService.importProfile")(function* (input) {
      return yield* unavailable(input.instanceId, "importProfile");
    }),
    start: Effect.fn("ProviderAuthService.start")(function* (input) {
      return yield* unavailable(input.instanceId, "start");
    }),
    complete: Effect.fn("ProviderAuthService.complete")(function* (input) {
      return yield* unavailable(input.instanceId, "complete");
    }),
    respond: Effect.fn("ProviderAuthService.respond")(function* (input) {
      return yield* unavailable(input.instanceId, "respond");
    }),
    cancel: Effect.fn("ProviderAuthService.cancel")(function* (input) {
      return yield* unavailable(input.instanceId, "cancel");
    }),
    logout: Effect.fn("ProviderAuthService.logout")(function* (input) {
      return yield* unavailable(input.instanceId, "logout");
    }),
    subscribe: (input) => Stream.fail(unavailable(input.instanceId, "subscribe")),
    tryHandlePromptCommand: Effect.fn("ProviderAuthService.tryHandlePromptCommand")(function* () {
      return false;
    }),
  }),
);
