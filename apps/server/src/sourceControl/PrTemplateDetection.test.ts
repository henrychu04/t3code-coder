import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { detectPrTemplate } from "./PrTemplateDetection.ts";

const defaultObject = "a".repeat(40);
const alternateObject = "b".repeat(40);

it.effect("recognizes GitLab templates and prefers Default.md when several exist", () => {
  const executeGit: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout:
        input.args[0] === "ls-tree"
          ? [
              `100644 blob ${alternateObject}\t.gitlab/merge_request_templates/bug.md\0`,
              `100644 blob ${defaultObject}\t.gitlab/merge_request_templates/Default.md\0`,
            ].join("")
          : input.args.at(-1) === defaultObject
            ? "default template\n"
            : "alternate template\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });

  return Effect.gen(function* () {
    const template = yield* detectPrTemplate("/repo", "HEAD", executeGit);
    assert.strictEqual(Option.getOrUndefined(template), "default template");
  });
});
