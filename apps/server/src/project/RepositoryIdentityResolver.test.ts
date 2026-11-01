import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import { make } from "./RepositoryIdentityResolver.ts";

// Coder: the mocked cases resolve made-up workspace paths, so every path reads as a folder holding
// the entries the resolver checks before it probes with Git (#27980).
const existingFolders = Layer.merge(
  FileSystem.layerNoop({
    stat: () => Effect.succeed({ type: "Directory" } as FileSystem.File.Info),
    exists: () => Effect.succeed(true),
  }),
  Path.layer,
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

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

describe("RepositoryIdentityResolver", () => {
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
        Effect.provide(existingFolders),
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

  it.effect("reuses the cached Git root for repeated workspace lookups", () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const process = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            calls.push(input.args);
            return input.args.includes("--show-toplevel")
              ? output("/workspace/project\n")
              : output("origin https://gitlab.example.gs.com/goldman/smoke.git (fetch)\n");
          }),
      });
      const resolver = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, process),
        Effect.provide(existingFolders),
      );

      const first = yield* resolver.resolve("/workspace/project/src");
      const second = yield* resolver.resolve("/workspace/project/src");

      expect(second).toEqual(first);
      expect(calls).toEqual([
        ["-C", "/workspace/project/src", "rev-parse", "--show-toplevel"],
        ["-C", "/workspace/project", "remote", "-v"],
      ]);
    }),
  );

  it.effect("caches failed Git root discovery until an explicit refresh", () =>
    Effect.gen(function* () {
      let rootAttempts = 0;
      const process = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            if (!input.args.includes("--show-toplevel")) {
              return output("origin https://gitlab.example.gs.com/goldman/smoke.git (fetch)\n");
            }
            rootAttempts += 1;
            return rootAttempts === 1
              ? { ...output(""), code: ChildProcessSpawner.ExitCode(1) }
              : output("/workspace/project\n");
          }),
      });
      const resolver = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, process),
        Effect.provide(existingFolders),
      );

      expect(yield* resolver.resolve("/workspace/project/src")).toBeNull();
      yield* TestClock.adjust(Duration.seconds(59));
      expect(yield* resolver.resolve("/workspace/project/src")).toBeNull();
      expect(rootAttempts).toBe(1);
      expect((yield* resolver.resolve("/workspace/project/src", { refresh: true }))?.rootPath).toBe(
        "/workspace/project",
      );
      expect(rootAttempts).toBe(2);
    }),
  );

  // Coder: upstream's local-remote and display-casing cases on GitLab remotes, mocked like the
  // tests above.
  it.effect("skips local-path remotes and keeps the remote's display casing", () =>
    Effect.gen(function* () {
      const process = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed(
            input.args.includes("--show-toplevel")
              ? output("/workspace/project\n")
              : output(
                  [
                    "gb-local\t. (fetch)",
                    "backup\t/srv/git/repo.git (fetch)",
                    "archive\tfile:///srv/git/repo.git (fetch)",
                    "mirror\tgit@gitlab.example.gs.com:Goldman/Platform/Smoke.git (fetch)",
                    "",
                  ].join("\n"),
                ),
          ),
      });
      const resolver = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, process),
        Effect.provide(existingFolders),
      );

      const identity = yield* resolver.resolve("/workspace/project");

      expect(identity?.locator.remoteName).toBe("mirror");
      expect(identity).toMatchObject({
        canonicalKey: "gitlab.example.gs.com/goldman/platform/smoke",
        displayName: "Goldman/Platform/Smoke",
        owner: "Goldman",
        name: "Smoke",
      });
    }),
  );

  // Coder: upstream's partial-clone case on a GitLab remote, mocked like the tests above.
  it.effect("resolves the fetch remote of a partial clone", () =>
    Effect.gen(function* () {
      const process = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed(
            input.args.includes("--show-toplevel")
              ? output("/workspace/project\n")
              : output(
                  [
                    "origin\tgit@gitlab.com:T3Tools/t3code.git (fetch) [blob:none]",
                    "origin\tgit@gitlab.com:T3Tools/push.git (push)",
                    "",
                  ].join("\n"),
                ),
          ),
      });
      const resolver = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, process),
        Effect.provide(existingFolders),
      );

      const identity = yield* resolver.resolve("/workspace/project");

      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/t3code");
      expect(identity?.locator.remoteUrl).toBe("git@gitlab.com:T3Tools/t3code.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }),
  );

  // Coder: upstream's bare-repository cases (#17340) on GitLab remotes, mocked like the tests
  // above.
  it.effect.each(["times out", "cannot start"] as const)(
    "skips the bare repository probe when Git root discovery %s",
    (failure) =>
      Effect.gen(function* () {
        let attempts = 0;
        const process = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.suspend(() => {
              attempts++;
              return failure === "times out"
                ? Effect.succeed({ ...output(""), code: null, timedOut: true })
                : Effect.fail(
                    new ProcessRunner.ProcessSpawnError({
                      command: input.command,
                      argumentCount: input.args.length,
                      cause: new Error("git is not installed"),
                    }),
                  );
            }),
        });
        const resolver = yield* make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, process),
          Effect.provide(existingFolders),
        );

        expect(yield* resolver.resolve("/workspace/project")).toBeNull();
        expect(attempts).toBe(1);
      }),
  );

  it.effect.each(["bare clone", "dot-bare"] as const)(
    "resolves a %s to its Git directory and the same identity as a checkout",
    (layout) =>
      Effect.gen(function* () {
        const gitDir = layout === "dot-bare" ? "/srv/smoke/.bare" : "/srv/smoke.git";
        const calls: ReadonlyArray<string>[] = [];
        const process = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input.args);
              const notARepository = { ...output(""), code: ChildProcessSpawner.ExitCode(128) };
              if (input.args.includes("--show-toplevel")) return notARepository;
              if (input.args.includes("--is-bare-repository")) {
                const probe = input.args.find((arg) => arg.startsWith("--git-dir="));
                return probe === (layout === "dot-bare" ? "--git-dir=.git" : "--git-dir=.")
                  ? output(`true\n${gitDir}\n`)
                  : notARepository;
              }
              return output("origin\tgit@gitlab.example.gs.com:goldman/smoke.git (fetch)\n");
            }),
        });
        const resolver = yield* make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, process),
          Effect.provide(existingFolders),
        );

        const identity = yield* resolver.resolve(layout === "dot-bare" ? "/srv/smoke" : gitDir);

        expect(identity?.canonicalKey).toBe("gitlab.example.gs.com/goldman/smoke");
        expect(identity?.rootPath).toBe(gitDir);
        expect(calls.at(-1)).toEqual(["-C", gitDir, "--git-dir=.", "remote", "-v"]);
      }),
  );

  it.effect("does not treat a checkout's .git directory as a project root", () =>
    Effect.gen(function* () {
      const process = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed(
            input.args.includes("--show-toplevel")
              ? { ...output(""), code: ChildProcessSpawner.ExitCode(128) }
              : input.args.includes("--is-bare-repository")
                ? output("false\n/workspace/project/.git\n")
                : output("origin\tgit@gitlab.example.gs.com:goldman/smoke.git (fetch)\n"),
          ),
      });
      const resolver = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, process),
        Effect.provide(existingFolders),
      );

      expect(yield* resolver.resolve("/workspace/project/.git")).toBeNull();
    }),
  );

  // Coder: upstream's case on real temporary folders, outside its `it.layer`.
  it.effect(
    "returns null for non-git, missing and no-remote folders, probing only what can exist",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-non-git-",
        });
        const gitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-no-remote-",
        });

        yield* git(gitDir, ["init"]);

        const runner = yield* ProcessRunner.ProcessRunner;
        const runs: Array<ReadonlyArray<string>> = [];
        const resolver = yield* make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.suspend(() => {
                runs.push(input.args);
                return runner.run(input);
              }),
          }),
        );
        const bareProbes = () =>
          runs.filter((args) => args.some((arg) => arg.startsWith("--git-dir=")));

        expect(yield* resolver.resolve(path.join(nonGitDir, "deleted"))).toBeNull();
        expect(runs).toEqual([]);

        expect(yield* resolver.resolve(nonGitDir)).toBeNull();
        expect(bareProbes()).toEqual([]);

        expect(yield* resolver.resolve(gitDir)).toBeNull();
      }).pipe(Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
  );
});
