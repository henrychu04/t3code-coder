import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

export interface RepositoryIdentityResolverOptions {}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  _options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "RepositoryIdentityResolver.resolve",
  )(function* (cwd) {
    const result = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (result._tag === "None" || result.value.code !== 0) return null;

    const rootPath = result.value.stdout.trim();
    if (rootPath.length === 0) return null;
    const name = rootPath.split(/[\\/]/).filter(Boolean).at(-1);
    return {
      canonicalKey: `workspace:${rootPath}`,
      locator: { source: "workspace-path", path: rootPath },
      rootPath,
      ...(name ? { displayName: name, name } : {}),
    };
  });

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
