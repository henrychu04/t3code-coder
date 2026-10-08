/**
 * Coder: Codex and Claude Code authenticate inside the Linux workspace through the provider's own
 * configuration. T3 Coder has no provider sign-in, logout, or credential-transfer flows, so every
 * auth operation is unavailable and prompts are never intercepted as auth commands.
 *
 * @module provider/Layers/ProviderAuthService
 */
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderAuthService from "../Services/ProviderAuthService.ts";

const unavailable = (instanceId: ProviderInstanceId, operation: string) =>
  new ProviderSetupError({
    instanceId,
    operation,
    detail: "Provider sign-in is managed in the Coder workspace, not by T3 Coder.",
  });

export const ProviderAuthServiceLive = Layer.succeed(
  ProviderAuthService.ProviderAuthService,
  ProviderAuthService.ProviderAuthService.of({
    reconnectProfile: (input) => Effect.fail(unavailable(input.instanceId, "reconnectProfile")),
    importProfile: (input) => Effect.fail(unavailable(input.instanceId, "importProfile")),
    start: (input) => Effect.fail(unavailable(input.instanceId, "start")),
    complete: (input) => Effect.fail(unavailable(input.instanceId, "complete")),
    respond: (input) => Effect.fail(unavailable(input.instanceId, "respond")),
    cancel: (input) => Effect.fail(unavailable(input.instanceId, "cancel")),
    logout: (input) => Effect.fail(unavailable(input.instanceId, "logout")),
    subscribe: (input) => Stream.fail(unavailable(input.instanceId, "subscribe")),
    tryHandlePromptCommand: () => Effect.succeed(false),
  }),
);
