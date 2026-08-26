import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { MAX_REVIEW_DIFF_FILE_BYTES, ReviewDiffFileError } from "./review.ts";

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
