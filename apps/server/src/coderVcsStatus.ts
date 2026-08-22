import type { GitCommandError, VcsStatusResult, VcsStatusStreamEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "./git/GitWorkflowService.ts";

interface StatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

export class CoderVcsStatus extends Context.Service<
  CoderVcsStatus,
  {
    readonly refresh: (cwd: string) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly stream: (cwd: string) => Stream.Stream<VcsStatusStreamEvent, GitCommandError>;
  }
>()("t3/coderVcsStatus") {}

export const layer = Layer.effect(
  CoderVcsStatus,
  Effect.gen(function* () {
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const changes = yield* PubSub.unbounded<StatusChange>();
    const read = (cwd: string) => workflow.localStatus({ cwd });
    const refresh = (cwd: string) =>
      read(cwd).pipe(
        Effect.tap((status) =>
          PubSub.publish(changes, {
            cwd,
            event: { _tag: "localUpdated" as const, local: status },
          }),
        ),
      );
    return CoderVcsStatus.of({
      refresh,
      stream: (cwd) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const latest = yield* read(cwd);
            return Stream.concat(
              Stream.make({
                _tag: "snapshot" as const,
                local: latest,
              }),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((change) => change.cwd === cwd),
                Stream.map((change) => change.event),
              ),
            );
          }),
        ),
    });
  }),
);
