import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../pathExpansion.ts";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import { resolvePastedImageAttachment } from "../provider/PastedImageAttachments.ts";
import {
  discoverCodexMcpServerNames,
  type CodexMcpServerNameResolver,
} from "../provider/Layers/CodexIntegrationPolicy.ts";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const CODEX_TIMEOUT_MS = 180_000;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  attachmentsDir?: string,
  mcpServerNameResolver?: CodexMcpServerNameResolver,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;
  const launchArgs = resolveCodexLaunchArgs(codexConfig.launchArgs, resolvedEnvironment);
  const resolveMcpServerNames: CodexMcpServerNameResolver =
    mcpServerNameResolver ??
    ((cwd) =>
      discoverCodexMcpServerNames({
        binaryPath: codexConfig.binaryPath || "codex",
        launchArgs,
        cwd,
        homePath: codexConfig.homePath,
        environment: resolvedEnvironment,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner)));

  const readStreamAsString = <E>(
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const writeTempFile = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError, Scope.Scope> =>
    fileSystem.makeTempFileScoped({ prefix: `t3code-${prefix}-${process.pid}-` }).pipe(
      Effect.tap((filePath) => fileSystem.writeFileString(filePath, content)),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to write temporary Codex file.",
            cause,
          }),
      ),
    );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly imagePaths?: ReadonlyArray<string>;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const schemaJson = yield* encodeJsonString(toJsonSchemaObject(input.outputSchemaJson)).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );
    const schemaPath = yield* writeTempFile(input.operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(input.operation, "codex-output", "");
    const disabledMcpServerNames = yield* resolveMcpServerNames(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const reasoningEffort =
      getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
      DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
    const serviceTier = getCodexServiceTierOptionValue(input.modelSelection);
    const spawnCommand = yield* resolveSpawnCommand(
      codexConfig.binaryPath || "codex",
      [
        "exec",
        ...codexExecLaunchArgs(launchArgs, disabledMcpServerNames),
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "--model",
        input.modelSelection.model,
        "--config",
        `model_reasoning_effort="${reasoningEffort}"`,
        ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        ...(input.imagePaths ?? []).flatMap((imagePath) => ["--image", imagePath]),
        "-",
      ],
      { env: resolvedEnvironment },
    );
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: {
        ...resolvedEnvironment,
        ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
      },
      cwd: input.cwd,
      shell: spawnCommand.shell,
      stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
    });

    const run = Effect.gen(function* () {
      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", input.operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(input.operation, child.stdout),
          readStreamAsString(input.operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError(
                "codex",
                input.operation,
                cause,
                "Failed to read Codex CLI exit code",
              ),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: detail
            ? `Codex CLI command failed: ${detail}`
            : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    yield* run.pipe(
      Effect.timeoutOption(CODEX_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Codex CLI request timed out.",
              }),
            ),
          onSome: () => Effect.void,
        }),
      ),
    );

    return yield* fileSystem.readFileString(outputPath).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Failed to read Codex output file.",
            cause,
          }),
      ),
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))),
      Effect.catchTag(
        "SchemaError",
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Codex returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CodexTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt(input);
      const generated = yield* runCodexJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CodexTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runCodexJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const resolveImagePaths = Effect.fn("CodexTextGeneration.resolveImagePaths")(function* (
    input: TextGeneration.BranchNameGenerationInput,
    operation: "generateBranchName" | "generateThreadTitle",
  ) {
    if (!input.attachments || input.attachments.length === 0) return [];
    if (!attachmentsDir) {
      return yield* new TextGenerationError({
        operation,
        detail: "Pasted image attachments are unavailable in this workspace.",
      });
    }
    return yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        resolvePastedImageAttachment({ attachmentsDir, attachment }).pipe(
          Effect.map((resolved) => resolved.path),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: cause.message,
                cause,
              }),
          ),
        ),
      { concurrency: 1 },
    );
  });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CodexTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({ message: input.message });
      const imagePaths = yield* resolveImagePaths(input, "generateBranchName");
      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        imagePaths,
      }).pipe(Effect.scoped);
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CodexTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
      });
      const imagePaths = yield* resolveImagePaths(input, "generateThreadTitle");
      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        imagePaths,
      }).pipe(Effect.scoped);
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
