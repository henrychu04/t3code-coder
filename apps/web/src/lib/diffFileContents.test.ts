import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, type ReviewDiffFileContentsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createChunkedGitDiffFileContentsLoader,
  createGitDiffFileContentsLoader,
  getDiffFileTooLargeMaxBytes,
  withDiffFileTooLargeReporting,
} from "./diffFileContents";

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceCacheNamespace = (source: typeof SOURCE) =>
  JSON.stringify([
    source.environmentId,
    source.cwd,
    source.sourceKind,
    source.baseRef,
    source.headRef,
    source.cacheKey,
  ]);

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "a/src/old-name.ts",
    name: "b/src/new-name.ts",
  } as FileDiffMetadata;
}

describe("getDiffFileTooLargeMaxBytes", () => {
  it("recognizes the typed RPC error without depending on its message", () => {
    expect(
      getDiffFileTooLargeMaxBytes({
        _tag: "ReviewDiffFileTooLargeError",
        path: "large.ts",
        maxBytes: 32 * 1024 * 1024,
        message: "wording may change",
      }),
    ).toBe(32 * 1024 * 1024);
  });

  it("ignores unrelated and malformed failures", () => {
    expect(getDiffFileTooLargeMaxBytes(new Error("network unavailable"))).toBeNull();
    expect(
      getDiffFileTooLargeMaxBytes({
        _tag: "ReviewDiffFileTooLargeError",
        maxBytes: 0,
      }),
    ).toBeNull();
  });
});

describe("withDiffFileTooLargeReporting", () => {
  it("reports the typed limit and declines hydration without rejecting", async () => {
    const failure = {
      _tag: "ReviewDiffFileTooLargeError",
      path: "src/new-name.ts",
      maxBytes: 32 * 1024 * 1024,
    };
    const report = vi.fn();
    const load = withDiffFileTooLargeReporting(
      vi.fn(async () => Promise.reject(failure)),
      report,
    );
    const diff = fileDiff();

    await expect(load(diff)).resolves.toBeNull();
    expect(report).toHaveBeenCalledWith(diff, 32 * 1024 * 1024);
  });

  it("does not classify unrelated loader failures as oversized files", async () => {
    const failure = new Error("snapshot expired");
    const report = vi.fn();
    const load = withDiffFileTooLargeReporting(
      vi.fn(async () => Promise.reject(failure)),
      report,
    );

    await expect(load(fileDiff())).rejects.toBe(failure);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("createGitDiffFileContentsLoader", () => {
  it("loads both sides with normalized paths and comparison-scoped cache keys", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).resolves.toEqual({
      oldFile: {
        name: "src/old-name.ts",
        contents: "before\n",
        cacheKey: `${sourceCacheNamespace(SOURCE)}:old:src/old-name.ts`,
      },
      newFile: {
        name: "src/new-name.ts",
        contents: "after\n",
        cacheKey: `${sourceCacheNamespace(SOURCE)}:new:src/new-name.ts`,
      },
    });
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace",
        sourceKind: "branch-range",
        changeType: "rename-changed",
        baseRef: "main",
        headRef: "feature",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });

  it("loads a pure rename from its one shared file", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "same\n", newContents: "same\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents: "same\n" },
    });
  });

  it("passes command failures through to Pierre's expansion handling", async () => {
    const failure = new Error("revision is not available locally");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});

describe("createChunkedGitDiffFileContentsLoader", () => {
  it("reports an oversized open outcome without reading chunks", async () => {
    const maxBytes = 32 * 1024 * 1024;
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "tooLarge" as const,
        path: "src/new-name.ts",
        maxBytes,
      }),
    );
    const read = vi.fn();
    const report = vi.fn();
    const diff = fileDiff("new");
    const load = withDiffFileTooLargeReporting(
      createChunkedGitDiffFileContentsLoader(open, read, {
        ...SOURCE,
        cacheKey: "oversized-comparison",
      }),
      report,
    );

    await expect(load(diff)).resolves.toBeNull();
    expect(report).toHaveBeenCalledWith(diff, maxBytes);
    expect(read).not.toHaveBeenCalled();
  });

  it("assembles bounded snapshots and reuses the in-memory file cache", async () => {
    const oldContents = "before\n";
    const newContents = "after\n";
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: { snapshotId: "old-snapshot", totalBytes: 7, contentHash: sha256(oldContents) },
        newFile: { snapshotId: "new-snapshot", totalBytes: 6, contentHash: sha256(newContents) },
      }),
    );
    const read = vi.fn(async ({ input }: { input: { snapshotId: string; offset: number } }) => {
      const contents = input.snapshotId === "old-snapshot" ? oldContents : newContents;
      const data = Buffer.from(contents, "utf8");
      return AsyncResult.success({
        snapshotId: input.snapshotId,
        offset: input.offset,
        totalBytes: data.byteLength,
        encoding: "base64" as const,
        decodedBytes: data.byteLength - input.offset,
        dataBase64: data.subarray(input.offset).toString("base64"),
        nextOffset: null,
      });
    });
    const load = createChunkedGitDiffFileContentsLoader(open, read, {
      ...SOURCE,
      cacheKey: "chunked-comparison",
    });

    await expect(load(fileDiff())).resolves.toMatchObject({
      oldFile: { contents: oldContents },
      newFile: { contents: newContents },
    });
    await expect(load(fileDiff())).resolves.toMatchObject({
      oldFile: { contents: oldContents },
      newFile: { contents: newContents },
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("decompresses gzip chunks before assembling file contents", async () => {
    const contents = "repeated source line\n".repeat(100);
    const bytes = new TextEncoder().encode(contents);
    const compressed = await new Response(
      new Blob([bytes.slice().buffer]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "gzip-snapshot",
          totalBytes: bytes.byteLength,
          contentHash: sha256(contents),
        },
      }),
    );
    const read = vi.fn(async () =>
      AsyncResult.success({
        snapshotId: "gzip-snapshot",
        offset: 0,
        totalBytes: bytes.byteLength,
        encoding: "gzip-base64" as const,
        decodedBytes: bytes.byteLength,
        dataBase64: Buffer.from(compressed).toString("base64"),
        nextOffset: null,
      }),
    );
    const load = createChunkedGitDiffFileContentsLoader(open, read, {
      ...SOURCE,
      cacheKey: "gzip-comparison",
    });

    await expect(load(fileDiff("new"))).resolves.toMatchObject({
      oldFile: { contents: "" },
      newFile: { contents },
    });
  });

  it("assembles UTF-8 characters split across chunk boundaries", async () => {
    const contents = "a🙂b";
    const bytes = new TextEncoder().encode(contents);
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "utf8-snapshot",
          totalBytes: bytes.byteLength,
          contentHash: sha256(contents),
        },
      }),
    );
    const read = vi.fn(async ({ input }: { input: { snapshotId: string; offset: number } }) => {
      const nextOffset = Math.min(input.offset + 2, bytes.byteLength);
      const chunk = bytes.subarray(input.offset, nextOffset);
      return AsyncResult.success({
        snapshotId: input.snapshotId,
        offset: input.offset,
        totalBytes: bytes.byteLength,
        encoding: "base64" as const,
        decodedBytes: chunk.byteLength,
        dataBase64: Buffer.from(chunk).toString("base64"),
        nextOffset: nextOffset < bytes.byteLength ? nextOffset : null,
      });
    });
    const load = createChunkedGitDiffFileContentsLoader(open, read, {
      ...SOURCE,
      cacheKey: "utf8-comparison",
    });

    await expect(load(fileDiff("new"))).resolves.toMatchObject({
      newFile: { contents },
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["snapshot id", { snapshotId: "wrong-snapshot" }],
    ["offset", { offset: 1 }],
    ["total byte count", { totalBytes: 4 }],
    ["decoded byte count", { decodedBytes: 2 }],
    ["next offset", { nextOffset: 2 }],
  ] as const)("rejects a chunk with a mismatched %s", async (_label, override) => {
    const contents = "abc";
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "invalid-frame-snapshot",
          totalBytes: 3,
          contentHash: sha256(contents),
        },
      }),
    );
    const read = vi.fn(async () =>
      AsyncResult.success({
        snapshotId: "invalid-frame-snapshot",
        offset: 0,
        totalBytes: 3,
        encoding: "base64" as const,
        decodedBytes: 3,
        dataBase64: Buffer.from(contents).toString("base64"),
        nextOffset: null,
        ...override,
      }),
    );
    const load = createChunkedGitDiffFileContentsLoader(open, read, {
      ...SOURCE,
      cacheKey: `invalid-frame-${_label}`,
    });

    await expect(load(fileDiff("new"))).rejects.toThrow("Invalid review file chunk.");
  });

  it("rejects empty, incomplete, corrupted, and hash-mismatched snapshots", async () => {
    const cases = [
      {
        cacheKey: "empty-chunk",
        contentHash: sha256("abc"),
        chunk: { dataBase64: "", decodedBytes: 0, nextOffset: null },
        message: "Invalid review file chunk.",
      },
      {
        cacheKey: "incomplete-chunk",
        contentHash: sha256("abc"),
        chunk: {
          dataBase64: Buffer.from("ab").toString("base64"),
          decodedBytes: 2,
          nextOffset: null,
        },
        message: "Incomplete review file snapshot.",
      },
      {
        cacheKey: "hash-mismatch",
        contentHash: sha256("abd"),
        chunk: {
          dataBase64: Buffer.from("abc").toString("base64"),
          decodedBytes: 3,
          nextOffset: null,
        },
        message: "Invalid review file snapshot hash.",
      },
    ];

    for (const testCase of cases) {
      const open = vi.fn(async () =>
        AsyncResult.success({
          _tag: "opened" as const,
          oldFile: null,
          newFile: {
            snapshotId: `${testCase.cacheKey}-snapshot`,
            totalBytes: 3,
            contentHash: testCase.contentHash,
          },
        }),
      );
      const read = vi.fn(async () =>
        AsyncResult.success({
          snapshotId: `${testCase.cacheKey}-snapshot`,
          offset: 0,
          totalBytes: 3,
          encoding: "base64" as const,
          ...testCase.chunk,
        }),
      );
      const load = createChunkedGitDiffFileContentsLoader(open, read, {
        ...SOURCE,
        cacheKey: testCase.cacheKey,
      });

      await expect(load(fileDiff("new"))).rejects.toThrow(testCase.message);
    }

    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "corrupt-gzip-snapshot",
          totalBytes: 3,
          contentHash: sha256("abc"),
        },
      }),
    );
    const read = vi.fn(async () =>
      AsyncResult.success({
        snapshotId: "corrupt-gzip-snapshot",
        offset: 0,
        totalBytes: 3,
        encoding: "gzip-base64" as const,
        decodedBytes: 3,
        dataBase64: Buffer.from("not gzip").toString("base64"),
        nextOffset: null,
      }),
    );
    const load = createChunkedGitDiffFileContentsLoader(open, read, {
      ...SOURCE,
      cacheKey: "corrupt-gzip",
    });

    await expect(load(fileDiff("new"))).rejects.toThrow();
  });

  it("isolates completed file caches by environment and repository", async () => {
    const makeLoader = (environmentId: string, cwd: string, contents: string) => {
      const bytes = Buffer.from(contents);
      const open = vi.fn(async () =>
        AsyncResult.success({
          _tag: "opened" as const,
          oldFile: null,
          newFile: {
            snapshotId: `${environmentId}-snapshot`,
            totalBytes: bytes.byteLength,
            contentHash: sha256(contents),
          },
        }),
      );
      const read = vi.fn(async () =>
        AsyncResult.success({
          snapshotId: `${environmentId}-snapshot`,
          offset: 0,
          totalBytes: bytes.byteLength,
          encoding: "base64" as const,
          decodedBytes: bytes.byteLength,
          dataBase64: bytes.toString("base64"),
          nextOffset: null,
        }),
      );
      return {
        load: createChunkedGitDiffFileContentsLoader(open, read, {
          ...SOURCE,
          environmentId: EnvironmentId.make(environmentId),
          cwd,
          cacheKey: "shared-diff-hash",
        }),
        open,
      };
    };
    const first = makeLoader("environment-cache-a", "/workspace/a", "first repo\n");
    const second = makeLoader("environment-cache-b", "/workspace/b", "second repo\n");

    await expect(first.load(fileDiff("new"))).resolves.toMatchObject({
      newFile: { contents: "first repo\n" },
    });
    await expect(second.load(fileDiff("new"))).resolves.toMatchObject({
      newFile: { contents: "second repo\n" },
    });
    expect(first.open).toHaveBeenCalledTimes(1);
    expect(second.open).toHaveBeenCalledTimes(1);
  });

  it("bounds cached empty files by entry count", async () => {
    const loaders = Array.from({ length: 129 }, (_, index) => {
      const snapshotId = `empty-snapshot-${index}`;
      const open = vi.fn(async () =>
        AsyncResult.success({
          _tag: "opened" as const,
          oldFile: null,
          newFile: { snapshotId, totalBytes: 0, contentHash: sha256("") },
        }),
      );
      return {
        open,
        load: createChunkedGitDiffFileContentsLoader(
          open,
          vi.fn(async () => {
            throw new Error("empty snapshots should not request chunks");
          }),
          { ...SOURCE, cacheKey: `empty-cache-${index}` },
        ),
      };
    });

    for (const loader of loaders) {
      await loader.load(fileDiff("new"));
    }
    await loaders[0]!.load(fileDiff("new"));

    expect(loaders[0]!.open).toHaveBeenCalledTimes(2);
    expect(loaders.at(-1)!.open).toHaveBeenCalledTimes(1);
  });
});
