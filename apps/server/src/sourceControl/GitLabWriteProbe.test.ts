import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabWriteProbe from "./GitLabWriteProbe.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

function output(exitCode: number, stderr = ""): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
    stdout: "{}",
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

it.effect("uses a state-free workspace-level mutation canary", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(
      Effect.succeed(output(1, "glab: 404 Project Not Found (HTTP 404)")),
    );
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
          "projects/0/merge_requests",
          "--method",
          "POST",
          "--input",
          "-",
          "--header",
          "Content-Type: application/json",
          "--include",
        ],
        stdin: "{}",
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

it.effect("fails closed when GitLab returns an unrecognized response", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(Effect.succeed(output(7)));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/repo" });

    expect(result).toEqual({
      status: "indeterminate",
      writable: false,
      detail:
        "The GitLab CLI exited with status 7, but its response did not match a known GitLab, authentication, or workspace-policy result.",
    });
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
    mockedRun.mockReturnValue(Effect.succeed(output(1, "glab: 404 Project Not Found (HTTP 404)")));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const concurrent = yield* Effect.all(
      [probe.check({ cwd: "/first" }), probe.check({ cwd: "/second" })],
      { concurrency: "unbounded" },
    );
    const later = yield* probe.check({ cwd: "/third" });

    expect([...concurrent, later]).toEqual([
      { status: "writable", writable: true },
      { status: "writable", writable: true },
      { status: "writable", writable: true },
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
        classifyProbe: (result) => (result.exitCode === 9 ? "writable" : "indeterminate"),
        isPolicyBlockedWriteFailure: () => false,
      }).pipe(Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun }))),
    ),
  ),
);

it.effect("requires a GitLab fingerprint before accepting the expected rejection", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(
      Effect.succeed(output(1, "glab: 404 Project Not Found (HTTP 404)")),
    );
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/workspace" });

    expect(result).toEqual({ status: "writable", writable: true });
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("recognizes an included HTTP/2 GitLab response", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(
      Effect.succeed({
        ...output(1),
        stdout: 'HTTP/2 404\r\nx-gitlab-meta: {"correlation_id":"redacted"}\r\n',
        stderr: "",
      }),
    );
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/workspace" });

    expect(result).toEqual({ status: "writable", writable: true });
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("fails closed when an otherwise writable response is truncated", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(
      Effect.succeed({
        ...output(1, "glab: 404 Project Not Found (HTTP 404)"),
        stdout: 'HTTP/2 404\r\nx-gitlab-meta: {"correlation_id":"redacted"}\r\n',
        stdoutTruncated: true,
      }),
    );
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/workspace" });

    expect(result).toEqual({
      status: "indeterminate",
      writable: false,
      detail: "The GitLab CLI response exceeded the probe output limit and was truncated.",
    });
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("reports an HTTP 401 response as unauthenticated", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(Effect.succeed(output(1, "glab: 401 (HTTP 401)")));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/workspace" });

    expect(result).toEqual({ status: "unauthenticated", writable: false });
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("does not treat a generic proxy 404 as proof of write access", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(Effect.succeed(output(1, "glab: 404 Not Found (HTTP 404)")));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/workspace" });

    expect(result).toEqual({
      status: "indeterminate",
      writable: false,
      detail:
        "The GitLab CLI exited with status 1, but its response did not match a known GitLab, authentication, or workspace-policy result.",
    });
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("reports a safe reason when the probe process times out", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(
      Effect.fail(
        new VcsProcessTimeoutError({
          operation: "GitLabWriteProbe.check",
          command: "glab",
          cwd: "/workspace/secret-project",
          argumentCount: 9,
          timeoutMs: 15_000,
        }),
      ),
    );
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/workspace/secret-project" });

    expect(result).toEqual({
      status: "indeterminate",
      writable: false,
      detail: "The GitLab write probe timed out after 15 seconds.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-project");
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("reports a bounded HTTP rejection without exposing response contents", () =>
  Effect.gen(function* () {
    mockedRun.mockReturnValueOnce(
      Effect.succeed(output(1, "glab: 403 Forbidden: private diagnostic (HTTP 403)")),
    );
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const result = yield* probe.check({ cwd: "/workspace" });

    expect(result).toEqual({
      status: "indeterminate",
      writable: false,
      detail:
        "GitLab or an intermediary rejected the write-shaped request with HTTP 403. Writes remain disabled.",
    });
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);

it.effect("reprobes explicitly and replaces the workspace result", () =>
  Effect.gen(function* () {
    mockedRun
      .mockReturnValueOnce(Effect.succeed(output(1, "write endpoints are disabled")))
      .mockReturnValueOnce(Effect.succeed(output(1, "glab: 404 Project Not Found (HTTP 404)")));
    const probe = yield* GitLabWriteProbe.GitLabWriteProbe;

    const blocked = yield* probe.check({ cwd: "/workspace" });
    const writable = yield* probe.reprobe({ cwd: "/workspace" });

    expect(blocked).toEqual({ status: "policy-blocked", writable: false });
    expect(writable).toEqual({ status: "writable", writable: true });
    expect(mockedRun).toHaveBeenCalledTimes(2);
  }).pipe(
    Effect.provide(
      GitLabWriteProbe.layer.pipe(
        Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
      ),
    ),
  ),
);
