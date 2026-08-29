import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, PastedImageAttachment, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";

export type TextGenerationProvider = "codex" | "claudeAgent";

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<PastedImageAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<PastedImageAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGeneration - Service tag for local branch and thread labels.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp = "generateBranchName" | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
