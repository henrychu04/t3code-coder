import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_REVIEW_DIFF_FILE_BYTES,
  ReviewDiffFileError,
  ReviewDiffFileSnapshotResult,
} from "./review.ts";

describe("ReviewDiffFileError", () => {
  it("decodes an oversized-file failure as a typed error", () => {
    const error = Schema.decodeUnknownSync(ReviewDiffFileError)({
      _tag: "ReviewDiffFileTooLargeError",
      path: "src/large.ts",
      maxBytes: MAX_REVIEW_DIFF_FILE_BYTES,
    });

    expect(error._tag).toBe("ReviewDiffFileTooLargeError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("src/large.ts");
  });

  it("rejects a non-positive expansion limit", () => {
    expect(() =>
      Schema.decodeUnknownSync(ReviewDiffFileError)({
        _tag: "ReviewDiffFileTooLargeError",
        path: "src/large.ts",
        maxBytes: 0,
      }),
    ).toThrow();
  });
});

describe("ReviewDiffFileSnapshotResult", () => {
  it("decodes opened and oversized outcomes", () => {
    expect(
      Schema.decodeUnknownSync(ReviewDiffFileSnapshotResult)({
        _tag: "opened",
        oldFile: null,
        newFile: null,
      }),
    ).toEqual({ _tag: "opened", oldFile: null, newFile: null });
    expect(
      Schema.decodeUnknownSync(ReviewDiffFileSnapshotResult)({
        _tag: "tooLarge",
        path: "src/large.ts",
        maxBytes: MAX_REVIEW_DIFF_FILE_BYTES,
      }),
    ).toEqual({
      _tag: "tooLarge",
      path: "src/large.ts",
      maxBytes: MAX_REVIEW_DIFF_FILE_BYTES,
    });
  });

  it("rejects an invalid oversized outcome", () => {
    expect(() =>
      Schema.decodeUnknownSync(ReviewDiffFileSnapshotResult)({
        _tag: "tooLarge",
        path: "src/large.ts",
        maxBytes: 0,
      }),
    ).toThrow();
  });
});
