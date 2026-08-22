import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class CoderBackgroundPolicy extends Context.Service<
  CoderBackgroundPolicy,
  {
    readonly shouldRunScopeWork: (scope: unknown) => Effect.Effect<boolean>;
  }
>()("t3/coderBackgroundPolicy") {}

export const layer = Layer.succeed(
  CoderBackgroundPolicy,
  CoderBackgroundPolicy.of({ shouldRunScopeWork: () => Effect.succeed(true) }),
);
