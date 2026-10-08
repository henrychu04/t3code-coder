import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderUsageLimitsUpdate, ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ServerProviderShape {
  readonly resolveMaintenance?: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Coder: optional because Coder does not fold runtime usage limits into provider snapshots.
   * Upstream's adapters type their usage-limit hook from this member.
   */
  readonly applyUsageLimits?: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
}
