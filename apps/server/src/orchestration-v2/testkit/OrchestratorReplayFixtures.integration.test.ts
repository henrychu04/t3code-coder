import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  ProviderReplayEntry,
  ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import {
  assertProviderNativeSubagentRootTurns,
  materializeFixtureInput,
  projectionFor,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";

const readTranscript = Effect.fn("readOrchestratorReplayTranscript")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function normalizeTestError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function transcriptEntriesThroughLabel(
  transcript: ProviderReplayTranscript,
  label: string | undefined,
): ProviderReplayTranscript {
  if (label === undefined) {
    return transcript;
  }
  const entryIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === label,
  );
  if (entryIndex === -1) {
    throw new Error(`${transcript.scenario} is missing inbound transcript label ${label}.`);
  }
  return {
    ...transcript,
    entries: transcript.entries.slice(0, entryIndex + 1),
  };
}

function isStreamingAssistantEvent(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "node.updated":
      return event.payload.kind === "assistant_message" && event.payload.status === "running";
    case "message.updated":
      return event.payload.role === "assistant" && event.payload.streaming;
    case "turn-item.updated":
      return event.payload.type === "assistant_message" && event.payload.streaming;
    default:
      return false;
  }
}

const runFixtureProvider = Effect.fn("runOrchestratorReplayFixture")(function* <
  Transcript extends ProviderReplayTranscript,
  Error,
>(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly driver: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  readonly transformTranscript?: (transcript: ProviderReplayTranscript) => ProviderReplayTranscript;
}) {
  const recordedTranscript = yield* readTranscript(input.driver.transcriptFile);
  const rawTranscript = input.transformTranscript?.(recordedTranscript) ?? recordedTranscript;
  const replayTranscript = materializeReplayTranscriptRuntimeInstructions(
    transcriptEntriesThroughLabel(rawTranscript, input.driver.transcriptEntriesThroughLabel),
    { driver: input.driver.driver, model: input.driver.modelSelection.model },
  );
  const fixtureInput = input.buildInput();
  const workspace = yield* checkpointWorkspace(input.fixtureName, fixtureInput.workspaceFiles);
  // Muse canonicalizes its workspace path (macOS /var -> /private/var) before sending it.
  const transcript = yield* input.harness.decodeTranscript(
    input.driver.driver === "codex"
      ? materializeReplayTranscriptWorkspace(replayTranscript, workspace)
      : input.driver.driver === "muse"
        ? materializeReplayTranscriptWorkspace(
            replayTranscript,
            yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.realPath(workspace)),
              Effect.provide(NodeServices.layer),
            ),
          )
        : replayTranscript,
  );
  const materialized = yield* materializeFixtureInput({
    scenario: input.fixtureName,
    fixtureInput,
    driver: input.driver.driver,
    modelSelection: input.driver.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${input.fixtureName}/${input.driver.driver}`,
    transcript,
    commands: materialized.commands,
    steps: materialized.steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: {
      ...input.driver.runtimePolicyOverride,
      cwd: workspace,
    },
  };

  const result = yield* runOrchestratorV2ProviderReplayScenario(
    scenario,
    input.harness,
    input.driver.runContinuationWorker === true ? { runContinuationWorker: true } : {},
  ).pipe(provideDeterministicTestRuntime);
  input.driver.assertOutput(result, transcript);
  assertProviderNativeSubagentRootTurns(result);
  const expectedAbsentWorkspacePaths = input.driver.expectedAbsentWorkspacePaths;
  if (expectedAbsentWorkspacePaths !== undefined) {
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const relativePath of expectedAbsentWorkspacePaths) {
        assert.isFalse(
          yield* fs.exists(path.join(workspace, relativePath)),
          `${input.fixtureName}/${input.driver.driver} must not create ${relativePath} in the replay workspace`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer));
  }
  assert.isFalse(
    result.domainEvents.some(isStreamingAssistantEvent),
    "buffered delivery must not persist streaming assistant artifacts",
  );
  const projectionThreadId = materialized.projectionThreadIds[0];
  assert.isDefined(projectionThreadId);
  const projection = result.projections.get(projectionThreadId);
  assert.isDefined(projection);
  const latestRun = projection.runs.at(-1);
  assert.deepEqual(latestRun?.modelSelection, input.driver.modelSelection);
  if (projection.runs.some((run) => run.status === "completed")) {
    const threadStartCheckpoint = projection.checkpoints.find(
      (checkpoint) => checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null,
    );
    assert.isDefined(
      threadStartCheckpoint,
      "completed threads must retain an addressable thread-start checkpoint",
    );
    assert.equal(threadStartCheckpoint.status, "ready");
  }
  return result;
});

function runFixtureProviderWithRegisteredHarness(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly driver: ProviderOrchestratorReplayVariant;
  readonly transformTranscript?: (transcript: ProviderReplayTranscript) => ProviderReplayTranscript;
}) {
  switch (input.driver.driver) {
    case "codex":
      return runFixtureProvider({
        ...input,
        harness: CodexOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "claudeAgent":
      return runFixtureProvider({
        ...input,
        harness: ClaudeOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    default:
      return Effect.die(
        new Error(`No replay harness registered for provider ${input.driver.driver}.`),
      );
  }
}

// Coder: only the shipped providers have replay harnesses.
const SHIPPED_REPLAY_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

describe("orchestrator replay fixtures", () => {
  for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
    for (const provider of fixture.providers) {
      if (!SHIPPED_REPLAY_DRIVERS.has(provider.driver)) continue;
      it.effect(
        `runs ${fixture.name}/${provider.driver} through OrchestratorV2 using deterministic replay`,
        () =>
          runFixtureProviderWithRegisteredHarness({
            fixtureName: fixture.name,
            buildInput: fixture.buildInput,
            driver: provider,
          }),
      );
    }
  }
});
