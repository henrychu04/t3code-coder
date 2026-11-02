/**
 * Provider token reporting: one `provider.turn.completed` per provider turn and one
 * `provider.request.completed` per run, built from the same turns so each counts once.
 *
 * @module ProviderUsageAnalytics
 */
import type {
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RunAttempt,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// Coder: no T3-owned telemetry. Only the report shapes and the no-op `ProviderTurnAnalytics`
// reference stay, because carried orchestration files import them; the analytics layer, request
// ledger, and property builders are cut.

/**
 * Where the run's starting message came from. Most turns start without a
 * person (provider continuations, agent sends, delegated subagents), so
 * reports need this to tell user turns apart.
 */
export interface ProviderTurnOrigin {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduled: boolean;
  readonly subagent: boolean;
}

/** What started this provider turn inside its run. */
export type ProviderTurnSegment =
  | OrchestrationV2RunAttempt["reason"]
  | "continuation"
  | "native_child";

export interface ProviderTurnAnalyticsContext {
  readonly runId?: RunId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly origin?: ProviderTurnOrigin;
  readonly segment?: ProviderTurnSegment;
  readonly restartContinuation?: boolean;
}

export interface ProviderTurnReport {
  readonly driver: string;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly context?: ProviderTurnAnalyticsContext;
}

export interface RunSettledReport {
  readonly runId: RunId;
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly completedAt: DateTime.Utc;
  // Run-owned children were still open when the run settled; their later turns are not added.
  readonly childrenRunning: boolean;
}

export class ProviderTurnAnalytics extends Context.Reference<{
  readonly runStarted: (input: {
    readonly runId: RunId;
    readonly driver: string;
    readonly context: ProviderTurnAnalyticsContext;
  }) => Effect.Effect<void>;
  readonly turnCompleted: (report: ProviderTurnReport) => Effect.Effect<void>;
  readonly runSettled: (report: RunSettledReport) => Effect.Effect<void>;
}>("t3/telemetry/ProviderTurnAnalytics", {
  defaultValue: () => ({
    runStarted: () => Effect.void,
    turnCompleted: () => Effect.void,
    runSettled: () => Effect.void,
  }),
}) {}
