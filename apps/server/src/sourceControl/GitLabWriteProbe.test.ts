import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabWriteProbe from "./GitLabWriteProbe.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

function output(exitCode: number): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
    stdout: "{}",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

it.effect("uses a state-free CI lint POST as the default write probe", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(Effect.succeed(output(0)));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/repo" });

    assert.isTrue(result.writable);
    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "GitLabWriteProbe.check",
        command: "glab",
        cwd: "/repo",
        allowNonZeroExit: true,
        args: [
          "api",
          "projects/:fullpath/ci/lint",
          "--method",
          "POST",
          "--input",
          "-",
          "--header",
          "Content-Type: application/json",
        ],
      }),
    );
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("fails closed when the probe behavior rejects the response", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(Effect.succeed(output(7)));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/repo" });

    assert.isFalse(result.writable);
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("runs once for concurrent and later checks in the workspace runtime", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValue(Effect.succeed(output(0)));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const concurrent = yield* Effect.all(
      [probe.check({ cwd: "/first" }), probe.check({ cwd: "/second" })],
      { concurrency: "unbounded" },
    );
    const later = yield* probe.check({ cwd: "/third" });

    expect([...concurrent, later]).toEqual([
      { writable: true },
      { writable: true },
      { writable: true },
    ]);
    expect(mockedRun).toHaveBeenCalledOnce();
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("allows the probe request and classifier to be replaced together", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(Effect.succeed(output(9)));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/repo" });

    assert.isTrue(result.writable);
    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["custom", "probe"], stdin: "canary" }),
    );
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layerWithBehavior({
        request: () => ({ args: ["custom", "probe"], stdin: "canary" }),
        accepts: (result) => result.exitCode === 9,
      }).pipe(Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun }))),
    ),
  ),
);
