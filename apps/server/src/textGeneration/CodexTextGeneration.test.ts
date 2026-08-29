import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const DEFAULT_SELECTION = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna");

function withFakeCodex<A, E, R>(
  input: {
    readonly output: string;
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly launchArgs?: string;
    readonly homePath?: string;
  },
  run: (harness: {
    readonly textGeneration: TextGeneration.TextGeneration["Service"];
    readonly argsPath: string;
    readonly homePath: string;
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-text-" });
    const binaryPath = path.join(tempDir, "codex");
    const argsPath = path.join(tempDir, "args");
    const homeCapturePath = path.join(tempDir, "home");

    yield* fileSystem.writeFileString(
      binaryPath,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" > "$T3_FAKE_ARGS_PATH"',
        'printf "%s" "${CODEX_HOME:-}" > "$T3_FAKE_HOME_PATH"',
        'output_path=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "  fi",
        "  shift",
        "done",
        'if [ -n "$output_path" ]; then',
        '  printf "%s" "$T3_FAKE_OUTPUT" > "$output_path"',
        "fi",
        'if [ -n "${T3_FAKE_STDERR:-}" ]; then',
        '  printf "%s\\n" "$T3_FAKE_STDERR" >&2',
        "fi",
        'exit "${T3_FAKE_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fileSystem.chmod(binaryPath, 0o755);

    const environment = {
      ...process.env,
      T3_FAKE_ARGS_PATH: argsPath,
      T3_FAKE_HOME_PATH: homeCapturePath,
      T3_FAKE_OUTPUT: input.output,
      T3_FAKE_EXIT_CODE: String(input.exitCode ?? 0),
      T3_FAKE_STDERR: input.stderr ?? "",
    };
    const textGeneration = yield* makeCodexTextGeneration(
      decodeCodexSettings({
        binaryPath,
        homePath: input.homePath ?? "",
        launchArgs: input.launchArgs ?? "",
      }),
      environment,
    );

    return yield* run({ textGeneration, argsPath, homePath: homeCapturePath });
  }).pipe(Effect.scoped);
}

it.layer(NodeServices.layer)("CodexTextGeneration", (it) => {
  it.effect("generates branch names through workspace Codex with safe exec arguments", () =>
    withFakeCodex(
      {
        output: JSON.stringify({ branch: "  Feat/Session Handling  " }),
        launchArgs: "--strict-config --listen 9000",
      },
      ({ textGeneration, argsPath }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Improve session handling.",
            modelSelection: DEFAULT_SELECTION,
          });
          const args = (yield* fileSystem.readFileString(argsPath)).split("\n");

          expect(generated.branch).toBe("feat/session-handling");
          expect(args).toContain("exec");
          expect(args).toContain("--ephemeral");
          expect(args).toContain("read-only");
          expect(args).toContain("--strict-config");
          expect(args).not.toContain("--listen");
          expect(args).toContain('model_reasoning_effort="low"');
        }),
    ),
  );

  it.effect("forwards model options and the workspace CODEX_HOME", () =>
    withFakeCodex(
      {
        output: JSON.stringify({ title: "  Investigate reconnect failures  " }),
        homePath: "/workspace/.codex-t3",
      },
      ({ textGeneration, argsPath, homePath }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate reconnect failures.",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol", [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ]),
          });
          const args = yield* fileSystem.readFileString(argsPath);

          expect(generated.title).toBe("Investigate reconnect failures");
          expect(args).toContain('model_reasoning_effort="xhigh"');
          expect(args).toContain('service_tier="priority"');
          expect(yield* fileSystem.readFileString(homePath)).toBe("/workspace/.codex-t3");
        }),
    ),
  );

  it.effect("returns a typed error for invalid structured output", () =>
    withFakeCodex({ output: JSON.stringify({ title: "not a branch" }) }, ({ textGeneration }) =>
      Effect.gen(function* () {
        const result = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix reconnect failures.",
            modelSelection: DEFAULT_SELECTION,
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain("invalid structured output");
        }
      }),
    ),
  );

  it.effect("returns a typed error when Codex exits non-zero", () =>
    withFakeCodex(
      {
        output: JSON.stringify({ title: "ignored" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      ({ textGeneration }) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread.",
              modelSelection: DEFAULT_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("codex execution failed");
          }
        }),
    ),
  );
});
