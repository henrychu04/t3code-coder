import * as Context from "effect/Context";

/** Acquiring this service waits for workspace runtime initialization. */
export class CoderRuntimeStartup extends Context.Service<CoderRuntimeStartup, {}>()(
  "t3/coderRuntimeStartup",
) {}
