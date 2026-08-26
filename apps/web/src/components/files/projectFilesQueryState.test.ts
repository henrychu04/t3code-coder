import type { ProjectReadFileResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { projectFileDataFromResult, projectFileReadMatches } from "./projectFilesQueryState";

const file: ProjectReadFileResult = {
  relativePath: "notes.txt",
  contents: "saved",
  byteLength: 5,
  truncated: false,
  revision: "revision-2",
};

describe("project file query state", () => {
  it("does not expose a previous success after an explicit refresh fails", () => {
    const previous = AsyncResult.success<ProjectReadFileResult, Error>(file);
    const failed = AsyncResult.failureWithPrevious(Cause.fail(new Error("file is gone")), {
      previous: Option.some(previous),
    });

    expect(AsyncResult.value(failed)).toEqual(Option.some(file));
    expect(projectFileDataFromResult(failed)).toBeNull();
  });

  it("clears a confirmed optimistic value only after the read cache has caught up", () => {
    expect(projectFileReadMatches(file, "saved", "revision-2")).toBe(true);
    expect(projectFileReadMatches(file, "old", "revision-1")).toBe(false);
  });
});
