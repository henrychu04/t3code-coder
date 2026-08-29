import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import { make, repositoryPathFromRemoteUrl } from "./RepositoryIdentityResolver.ts";

function output(stdout: string): ProcessRunner.ProcessRunOutput {
  return {
    code: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

describe("repositoryPathFromRemoteUrl", () => {
  it.each([
    ["https://gitlab.example.gs.com/goldman/smoke.git", "goldman/smoke"],
    ["ssh://git@gitlab.example.gs.com/goldman/platform/smoke.git", "goldman/platform/smoke"],
    ["git@gitlab.example.gs.com:goldman/platform/smoke.git", "goldman/platform/smoke"],
  ])("extracts the provider-native project path from %s", (remoteUrl, expected) => {
    expect(repositoryPathFromRemoteUrl(remoteUrl)).toBe(expected);
  });

  it.effect("stores host/repository as the canonical identity used by MR discovery", () =>
    Effect.gen(function* () {
      const process = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed(
            input.args.includes("--show-toplevel")
              ? output("/workspace/project\n")
              : output("origin https://gitlab.example.gs.com/goldman/platform/smoke.git (fetch)\n"),
          ),
      });
      const resolver = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, process),
      );

      const identity = yield* resolver.resolve("/workspace/project/src");

      expect(identity).toMatchObject({
        canonicalKey: "gitlab.example.gs.com/goldman/platform/smoke",
        displayName: "goldman/platform/smoke",
        provider: "gitlab",
        owner: "goldman",
        name: "smoke",
      });
    }),
  );
});
