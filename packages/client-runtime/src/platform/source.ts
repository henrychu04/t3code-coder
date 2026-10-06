import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

import type { PlatformConnectionRegistration } from "../connection/catalog.ts";

export class PlatformConnectionSource extends Context.Service<
  PlatformConnectionSource,
  {
    // Each emission is the full current set of platform-managed environments
    // (the primary local environment plus any desktop-local backends running
    // alongside it). The registry reconciles the set, so the source can drive
    // both additions and removals by re-emitting.
    readonly registrations: Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>>;
    // Coder: an environment also leaves `registrations` while its workspace is stopped or
    // disconnected. Only removal from the Coder config clears its browser-held data.
    readonly removedEnvironmentIds: Stream.Stream<EnvironmentId>;
  }
>()("@t3tools/client-runtime/platform/source/PlatformConnectionSource") {}
