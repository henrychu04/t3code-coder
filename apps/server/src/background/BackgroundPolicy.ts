// Coder: VCS polling is already scoped to browser subscription demand. With no
// client activity leases or host power monitor, scope work is always allowed.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface BackgroundScope {
  readonly type: "vcs-status";
  readonly cwd: string;
}

export class BackgroundPolicy extends Context.Service<
  BackgroundPolicy,
  {
    readonly shouldRunScopeWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
  }
>()("t3/background/BackgroundPolicy") {}

export const layer = Layer.succeed(BackgroundPolicy, {
  shouldRunScopeWork: () => Effect.succeed(true),
});
