import { type TerminalSummary, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, subscribeDynamic, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  nextTerminalAttachSeedState,
} from "./terminalSession.ts";
import { TerminalBufferCache } from "./terminalBufferCache.ts";

// Coder: attach resumes from the cached output and its last sequence when the helper's replay
// window still covers the gap.
const terminalBufferCache = new TerminalBufferCache();

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const terminalThreadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalThreadKey };
  return {
    observe: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:observe",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalObserve>) =>
        Stream.suspend(() =>
          subscribe(WS_METHODS.terminalObserve, input).pipe(
            Stream.scan(nextTerminalAttachSeedState, applyTerminalAttachStreamEvent),
          ),
        ),
    }),
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>, environmentId) => {
        // Retry an unanswered first attach unchanged so it can still open the shell.
        let replied = false;
        return Stream.suspend(() => {
          const seed = nextTerminalAttachSeedState();
          const cached = terminalBufferCache.read(environmentId, input);
          const initial =
            cached.version === 0
              ? seed
              : { ...cached, output: { ...cached.output, generation: seed.output.generation } };
          return subscribeDynamic(WS_METHODS.terminalAttach, () =>
            Effect.sync(() => {
              // Coder: each attempt resumes after the last sequence the cache applied.
              const current = terminalBufferCache.read(environmentId, input);
              const afterSequence = current.version === 0 ? null : (current.sequence ?? null);
              const afterEpoch = current.epoch ?? null;
              return {
                ...(replied ? { ...input, resume: true } : input),
                ...(afterSequence === null || afterEpoch === null
                  ? {}
                  : { afterSequence, afterEpoch }),
              };
            }),
          ).pipe(
            Stream.onFirst(() =>
              Effect.sync(() => {
                replied = true;
              }),
            ),
            Stream.scan(() => initial, applyTerminalAttachStreamEvent),
            Stream.tap((state) =>
              Effect.sync(() => terminalBufferCache.write(environmentId, input, state)),
            ),
          );
        });
      },
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.scan((): ReadonlyArray<TerminalSummary> => [], applyTerminalMetadataStreamEvent),
          // The scan seed is not an authoritative empty server snapshot.
          Stream.drop(1),
        ),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./terminalSession.ts";
